# Nordvia explorer

A small local web application over the knowledge graph: an overview with an interactive map of the
ontology, one page for each of the five competency questions (tiles, chart, table, the SPARQL that
produced them), a page that turns questions into SPARQL, and a SPARQL console.

## Run it

From the folder of the pack (the one that holds `kg/`, `ontology/` and `queries/`):

```
pip install -r requirements.txt
python app/serve.py
```

Then open <http://localhost:8080/>. The graph (about 120,000 triples) loads in a few seconds.
The page loads two web fonts from Google Fonts; without a connection it falls back to the system fonts.

Options: `--port 8765`, `--kg path/to/graph.ttl`, `--ontology path/to/ontology.ttl`.

## How it is built

- `serve.py` loads the ontology and the graph into an in-memory Oxigraph store and offers a
  read-only SPARQL endpoint (`/sparql`, SELECT and ASK; updates are rejected), the list of queries
  (`/api/queries`) and the static files.
- `static/` is the interface: plain HTML, CSS and JavaScript, no build step and no libraries; the
  charts are SVG drawn by `app.js`.
- The five pages run the files in `queries/*.rq` unchanged. The company, top-N and month filters are
  applied to the query result in the browser; the key date of the first question is written into
  the query (and the query shown on the page is the one that ran).
- Every chart has a table twin (Chart / Table switch) with CSV export.

## Ontology map

The page **Explore / Ontology map** (opened from a button on the Overview) is an interactive graph of the ontology, drawn from the ontology that is loaded in the store (not from a picture): classes grouped in the seven domains of the model, dashed arrows for subclass links, labelled arrows for object properties. Hover a class to follow its neighbours, click it for its definition, SAP source table, instance count, data properties and links, drag classes to rearrange, scroll to zoom, *Reset layout* to start over. Properties that the ontology declares without a domain or range are placed from the classes the data actually links.

## Ask the graph (natural language to SPARQL)

The page **Tools / Ask the graph** turns a question in English or Spanish into a SPARQL query, runs it on the graph and shows the query and the rows.

- **Engine.** Claude Code, which must be installed and logged in (run `claude` once in a terminal). The page runs it in print mode (`claude -p`) with your own Claude login, so no API key is needed.
- **No tools for Claude.** Every Claude Code tool (shell, files, web) is switched off; it only returns text, and it runs in an empty temporary folder.
- **What Claude receives** (`nl2sparql.py`): rules for the graph (no inference, unsigned amounts plus posting side, reversals, open items, key date 31 Dec 2025, identifiers), the classes and properties of the ontology with instance counts, the code lists, accounts, cost centres, and the five competency queries as worked examples. It is built from the loaded graph, so it follows the ontology if you change it (about 9,000 tokens per question).
- **Checks.** Every `nvf:` term must exist in the ontology (otherwise a warning is shown), updates are rejected, and the query must run; if it fails, Claude gets the error and corrects it once.
- **Limits.** A generated query can run and still be wrong in meaning. The query is always shown so you can read it and edit it in the console. Questions the graph cannot answer are reported as such.

Endpoints: `POST /api/ask`, `GET /api/ask/status`.
