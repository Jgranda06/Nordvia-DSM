"""
Nordvia knowledge graph explorer - local server.

Loads the knowledge graph and the ontology into an in-memory Oxigraph store and serves
  /            the explorer (static/index.html)
  /sparql      read-only SPARQL endpoint (SELECT and ASK), GET or POST
  /api/queries the competency queries found in ../queries/*.rq
  /api/info    size of the store and how long it took to load
  /api/ask     question in natural language -> SPARQL, written by Claude (Claude Code, `claude -p`)

Usage (from the folder of the pack):
    python app/serve.py
    python app/serve.py --kg kg/nordvia-kg.ttl --ontology ontology/nordvia-finance.ttl --port 8080
"""
import argparse
import json
import re
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pyoxigraph as ox

import nl2sparql

HERE = Path(__file__).resolve().parent
PACK = HERE.parent
STORE = None
INFO = {}
PACKINFO = None          # nl2sparql.Pack, built after the store is loaded
CLAUDE = None            # nl2sparql.Claude


def load_store(files):
    store = ox.Store()
    t0 = time.time()
    for path in files:
        with open(path, "rb") as fh:
            store.load(fh, "text/turtle")
        print(f"  loaded {path}")
    INFO.update(triples=len(store), loaded_in=round(time.time() - t0, 1),
                files=[str(Path(p).name) for p in files], pyoxigraph=ox.__version__)
    print(f"  {len(store):,} triples in {INFO['loaded_in']} s")
    return store


def term_json(t):
    """RDF term -> W3C SPARQL JSON results format."""
    if isinstance(t, ox.NamedNode):
        return {"type": "uri", "value": t.value}
    if isinstance(t, ox.BlankNode):
        return {"type": "bnode", "value": t.value}
    out = {"type": "literal", "value": t.value}
    if t.language:
        out["xml:lang"] = t.language
    elif t.datatype and t.datatype.value != "http://www.w3.org/2001/XMLSchema#string":
        out["datatype"] = t.datatype.value
    return out


UPDATE_WORDS = re.compile(r"^\s*(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|COPY|MOVE|ADD|WITH)\b", re.I)


def run_query(text):
    body = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    body = re.sub(r"(?i)\b(PREFIX\s+[^\s:]*:\s*<[^>]*>|BASE\s*<[^>]*>)", "", body)
    if UPDATE_WORDS.match(body):
        raise ValueError("This endpoint is read only: updates (INSERT, DELETE, LOAD, ...) are rejected. Use SELECT or ASK.")
    result = STORE.query(text)
    if isinstance(result, bool) or result.__class__.__name__ == "QueryBoolean":
        return {"head": {}, "boolean": bool(result)}
    if not hasattr(result, "variables"):
        raise ValueError("Only SELECT and ASK queries are accepted: this endpoint is read only")
    names = [v.value for v in result.variables]
    rows = []
    for solution in result:
        row = {}
        for name in names:
            term = solution[name]
            if term is not None:
                row[name] = term_json(term)
        rows.append(row)
    return {"head": {"vars": names}, "results": {"bindings": rows}}


def list_queries(folder):
    out = []
    for f in sorted(Path(folder).glob("*.rq")):
        out.append({"id": f.stem, "file": f.name, "text": f.read_text(encoding="utf-8")})
    return out


class Handler(SimpleHTTPRequestHandler):
    queries_folder = PACK / "queries"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE / "static"), **kwargs)

    def log_message(self, fmt, *args):
        if not self.path.startswith(("/sparql", "/api")):
            super().log_message(fmt, *args)

    def end_headers(self):
        # the interface files change while the app is being developed: never serve them from the browser cache
        if not any(h.startswith(b'Cache-Control') for h in getattr(self, '_headers_buffer', [])):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send(self, code, body, ctype):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def query_text(self):
        parts = urlparse(self.path)
        params = {k: v[0] for k, v in parse_qs(parts.query).items()}
        if self.command == "POST":
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8")
            kind = (self.headers.get("Content-Type") or "").split(";")[0].strip()
            if kind == "application/sparql-query":
                params["query"] = raw
            else:
                params.update({k: v[0] for k, v in parse_qs(raw).items()})
        return params.get("query")

    def sparql(self):
        text = self.query_text()
        if not text:
            return self.send(400, "Missing 'query' parameter", "text/plain")
        start = time.time()
        try:
            out = run_query(text)
        except Exception as error:                      # syntax errors go back to the person
            return self.send(400, f"SPARQL error: {error}", "text/plain")
        out["ms"] = int((time.time() - start) * 1000)
        self.send(200, json.dumps(out), "application/sparql-results+json")
        rows = len(out.get("results", {}).get("bindings", []))
        print(f"  query {out['ms']:>6} ms  {rows:>6} rows")

    def body_json(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8")
        return json.loads(raw or "{}")

    def ask(self):
        try:
            data = self.body_json()
            question = (data.get("question") or "").strip()
            if not question:
                return self.send(400, json.dumps({"error": "Write a question first."}), "application/json")
            if len(question) > 1500:
                return self.send(400, json.dumps({"error": "The question is too long (1,500 characters at most)."}), "application/json")
            if not CLAUDE.available:
                return self.send(503, json.dumps({"error": "Claude Code was not found ('claude' command).", "status": CLAUDE.status()}), "application/json")
            out = nl2sparql.answer(PACKINFO, CLAUDE, question)
            out["repaired"] = False
            for attempt in range(2):                       # run it here; one automatic repair if it fails
                if not out["sparql"]:
                    break
                try:
                    run_query(out["sparql"])
                    out["error"] = None
                    break
                except Exception as error:
                    out["error"] = str(error)
                    if attempt == 1:
                        break
                    fixed = nl2sparql.answer(PACKINFO, CLAUDE, question, previous=out["sparql"], error=str(error))
                    fixed["repaired"] = True
                    fixed["first_error"] = str(error)
                    fixed["seconds"] = round(fixed["seconds"] + out["seconds"], 1)
                    out = fixed
            self.send(200, json.dumps(out), "application/json")
            print(f"  ask   {out['seconds']:>6} s   {'ok' if out.get('sparql') and not out.get('error') else 'no query / error'}")
        except Exception as error:
            self.send(500, json.dumps({"error": str(error)}), "application/json")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/ask/status":
            return self.send(200, json.dumps(CLAUDE.status()), "application/json")
        if path == "/sparql":
            return self.sparql()
        if path == "/api/queries":
            return self.send(200, json.dumps(list_queries(self.queries_folder)), "application/json")
        if path == "/api/info":
            return self.send(200, json.dumps(INFO), "application/json")
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/sparql":
            return self.sparql()
        if path == "/api/ask":
            return self.ask()
        self.send(405, "This endpoint is read only", "text/plain")


def main():
    global STORE, PACKINFO, CLAUDE
    parser = argparse.ArgumentParser(description="Read-only SPARQL endpoint and explorer for the Nordvia graph")
    parser.add_argument("--kg", default=str(PACK / "kg" / "nordvia-kg.ttl"), help="knowledge graph (Turtle)")
    parser.add_argument("--ontology", default=str(PACK / "ontology" / "nordvia-finance.ttl"), help="ontology (Turtle)")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--claude-cmd", default="claude", help="Claude Code command, or the path to it (default: claude)")
    parser.add_argument("--claude-model", default=None, help="model for the 'Ask' page, e.g. sonnet or opus (default: the one of Claude Code)")
    parser.add_argument("--claude-use-api-key", action="store_true", help="let Claude Code use ANTHROPIC_API_KEY if it is set (by default it is ignored and your Claude login is used)")
    args = parser.parse_args()
    for label, path in (("knowledge graph", args.kg), ("ontology", args.ontology)):
        if not Path(path).is_file():
            raise SystemExit(f"  ERROR: {label} not found: {path}")
    print("Loading the graph ...")
    STORE = load_store([args.ontology, args.kg])
    PACKINFO = nl2sparql.Pack(STORE, Handler.queries_folder)
    CLAUDE = nl2sparql.Claude(args.claude_cmd, args.claude_model, args.claude_use_api_key)
    print("  Ask page: " + (f"Claude Code {CLAUDE.version}" if CLAUDE.available else "Claude Code not found"))
    print(f"\nNordvia explorer:  http://localhost:{args.port}/")
    print(f"SPARQL endpoint:   http://localhost:{args.port}/sparql\n")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
