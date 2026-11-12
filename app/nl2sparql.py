"""
Natural language -> SPARQL for the Nordvia graph, with Claude as the engine.

The page sends a question to /api/ask. This module
  1. builds a prompt: the role, a compact description of the ontology and of the data (all taken
     from the loaded graph), the five competency queries as worked examples, and the question;
  2. runs Claude Code in print mode (`claude -p`, no API key: it uses the person's own login) with
     every tool disabled, so it can only answer with text;
  3. extracts the SPARQL from the answer and checks every nvf: term against the ontology.

If Claude Code is not installed, /api/prompt returns the same prompt so it can be pasted into any
Claude chat, and the answer pasted back into the page.
"""
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

NVF = "https://nordvia.com/ontology/finance#"
ID = "https://nordvia.com/id/"
PREFIXES = """PREFIX nvf:     <https://nordvia.com/ontology/finance#>
PREFIX id:      <https://nordvia.com/id/>
PREFIX rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs:    <http://www.w3.org/2000/01/rdf-schema#>
PREFIX owl:     <http://www.w3.org/2002/07/owl#>
PREFIX xsd:     <http://www.w3.org/2001/XMLSchema#>
PREFIX skos:    <http://www.w3.org/2004/02/skos/core#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX foaf:    <http://xmlns.com/foaf/0.1/>
PREFIX org:     <http://www.w3.org/ns/org#>
PREFIX rov:     <http://www.w3.org/ns/regorg#>
PREFIX schema:  <https://schema.org/>
PREFIX locn:    <http://www.w3.org/ns/locn#>"""
SHORT = {NVF: "nvf:", ID: "id:", "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf:", "http://www.w3.org/2000/01/rdf-schema#": "rdfs:",
         "http://www.w3.org/2002/07/owl#": "owl:", "http://www.w3.org/2001/XMLSchema#": "xsd:", "http://www.w3.org/2004/02/skos/core#": "skos:",
         "http://purl.org/dc/terms/": "dcterms:", "http://xmlns.com/foaf/0.1/": "foaf:", "http://www.w3.org/ns/org#": "org:",
         "http://www.w3.org/ns/regorg#": "rov:", "https://schema.org/": "schema:", "http://www.w3.org/ns/locn#": "locn:"}

ROLE = """You translate questions about a company's accounting data into SPARQL 1.1 queries over one RDF graph. The graph holds SAP financial accounting data of three companies of Nordvia Retail for fiscal year 2025. You answer with one SPARQL query and nothing that runs anything: you have no tools and you do not need any.

How to answer
- Reply with exactly one fenced code block ```sparql ... ``` holding a single SELECT (or ASK) query, then one or two plain sentences saying what the query counts or lists and any assumption you made. Write nothing before the code block.
- The first line inside the block is a comment restating the question in one line. Start the query with the PREFIX lines you use.
- Use only classes, properties and individuals that appear in the description below. Never invent a term. Do not use SERVICE, FROM, updates (INSERT, DELETE, ...) or anything that writes.
- Give result columns readable names (?company, ?vendorName, ?amountEur). Order the rows in a way that answers the question. For a plain listing add LIMIT 200; aggregates need no limit.
- If the graph cannot answer the question (the data is not there), reply with a single line "# CANNOT_ANSWER: <reason>" and one sentence suggesting the closest question the graph can answer.
- The question may be in English or Spanish. Answer in the language of the question for the explanation; the SPARQL stays in English.

Rules that follow from how the graph is built (they matter; the worked examples show them in practice)
1. There is NO inference. An instance has only the classes asserted for it. A customer invoice is an nvf:CustomerInvoice (not nvf:Invoice), a vendor is an nvf:Vendor and also an nvf:Payee, a tax code is an nvf:InputTaxCode or an nvf:OutputTaxCode (not nvf:TaxCode). Check the instance counts in the class list: a class with 0 instances is only a grouping.
2. Money. Line items hold unsigned amounts; nvf:postingSide says whether the line is nvf:Debit or nvf:Credit. nvf:amountInGroupCurrency is in EUR (group currency), nvf:amountInLocalCurrency is in the currency of the company, nvf:amountInDocumentCurrency in the currency of the document. For totals across companies use the EUR amount.
3. Reversals. A document that has been reversed (nvf:ReversedDocument) and its reversal (nvf:ReversalDocument) cancel each other; leave both out of cost, revenue and open-item figures, as the worked examples do.
4. Open items. A customer line item is open at a date when it has no nvf:clearedBy, or its nvf:clearingDate is after that date. Debt age counts days from nvf:dueDate to the key date; the key date of the exercise is 31 December 2025.
5. Dates are xsd:dateTime; write literals as "2025-12-31T00:00:00"^^xsd:dateTime. See how the worked examples take differences of days.
6. Labels come in English and Spanish (skos:prefLabel with @en and @es). Filter LANG(?label) = "en" to avoid duplicate rows.
7. Companies are identified by dcterms:identifier ("1000" Iberia, EUR; "2000" US, USD; "3000" UK, GBP). Documents point to their company with nvf:inCompany. Customers, payees and G/L accounts are shared; they carry no company.
8. Instance IRIs: https://nordvia.com/id/<kind>/<code>, for example id:document/1000-1800000045-2025 (company-number-year), id:line-item/<document>-<line>, id:account/0000140000, id:customer/0000100027, id:payee/0000200069, id:company/1000, id:document-type/DR, id:posting-key/01. SAP codes are also available as dcterms:identifier.
"""


def short(iri):
    for ns, p in SHORT.items():
        if iri.startswith(ns):
            return p + iri[len(ns):]
    return f"<{iri}>"


class Pack:
    """Description of the ontology and the data, built once from the loaded store."""

    def __init__(self, store, queries_folder):
        self.store = store
        self.queries_folder = Path(queries_folder)
        self.terms = self._terms()
        self.context = self._context()
        self.system = ROLE + "\n\nPrefixes (declare the ones you use):\n" + PREFIXES + "\n\n" + self.context

    # ------------------------------------------------------------ helpers
    def rows(self, q):
        res = self.store.query(PREFIXES + "\n" + q)
        names = [v.value for v in res.variables]
        return [{n: (s[n].value if s[n] is not None else None) for n in names} for s in res]

    def _terms(self):
        out = set()
        for r in self.rows("SELECT DISTINCT ?t WHERE { { ?t ?p ?o } UNION { ?s ?t ?o } UNION { ?s ?p ?t . FILTER(isIRI(?t)) } FILTER(STRSTARTS(STR(?t), '%s')) }" % NVF):
            out.add(r["t"][len(NVF):])
        return out

    # ------------------------------------------------------------ the description
    def _context(self):
        L = []
        # classes
        counts = {r["c"]: int(r["n"]) for r in self.rows("SELECT ?c (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a ?c } GROUP BY ?c")}
        L.append("CLASSES of the ontology (instances in the graph; superclasses; meaning)")
        for r in self.rows("""SELECT ?c (GROUP_CONCAT(DISTINCT STR(?sup); separator=' ') AS ?sups) (SAMPLE(?d) AS ?def) WHERE {
              ?c a owl:Class . FILTER(STRSTARTS(STR(?c), '%s'))
              OPTIONAL { ?c rdfs:subClassOf ?sup . FILTER(isIRI(?sup)) }
              OPTIONAL { ?c skos:definition ?d } } GROUP BY ?c ORDER BY ?c""" % NVF):
            sups = ", ".join(short(s) for s in (r["sups"] or "").split() if s)
            L.append(f"- {short(r['c'])} [{counts.get(r['c'], 0)}]" + (f" < {sups}" if sups else "") + (f": {r['def']}" if r["def"] else ""))
        # properties
        used = {r["p"]: int(r["n"]) for r in self.rows("SELECT ?p (COUNT(*) AS ?n) WHERE { ?s ?p ?o } GROUP BY ?p")}
        L.append("\nPROPERTIES of the ontology (domain -> range, triples in the graph; meaning)")
        for r in self.rows("""SELECT ?p ?kind (SAMPLE(?dom) AS ?dom) (SAMPLE(?ran) AS ?ran) (SAMPLE(?d) AS ?def) (SAMPLE(?inv) AS ?inv) WHERE {
              { ?p a owl:ObjectProperty BIND('object' AS ?kind) } UNION { ?p a owl:DatatypeProperty BIND('data' AS ?kind) }
              FILTER(STRSTARTS(STR(?p), '%s'))
              OPTIONAL { ?p rdfs:domain ?dom FILTER(isIRI(?dom)) } OPTIONAL { ?p rdfs:range ?ran FILTER(isIRI(?ran)) }
              OPTIONAL { ?p skos:definition ?d } OPTIONAL { ?p owl:inverseOf ?inv } } GROUP BY ?p ?kind ORDER BY ?p""" % NVF):
            dom = short(r["dom"]) if r["dom"] else "any"
            ran = short(r["ran"]) if r["ran"] else "any"
            L.append(f"- {short(r['p'])} ({dom} -> {ran}) [{used.get(r['p'], 0):,}]" + (f" inverse {short(r['inv'])}" if r["inv"] else "") + (f": {r['def']}" if r["def"] else ""))
        L.append("\nOTHER PROPERTIES used in the graph (triples)")
        for p, n in sorted(used.items(), key=lambda kv: kv[0]):
            if not p.startswith(NVF) and not p.startswith("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"):
                L.append(f"- {short(p)} [{n:,}]")
        L.append("Typical use: dcterms:identifier is the SAP code of anything (company, account, customer, document number parts); skos:prefLabel is the name of an account, cost centre, document type or posting key (@en, @es); "
                 "foaf:name is the name of a customer or payee; rov:legalName the name of a company; schema:taxID the tax number of a partner; locn:address leads to locn:postName (city), locn:postCode, locn:adminUnitL1 (country).")
        # companies
        L.append("\nCOMPANIES")
        for r in self.rows("SELECT ?id ?name ?cur WHERE { ?c a nvf:Company ; dcterms:identifier ?id ; rov:legalName ?name ; nvf:localCurrency/skos:notation ?cur } ORDER BY ?id"):
            L.append(f"- id:company/{r['id']}  {r['name']}  local currency {r['cur']}")
        # code lists
        L.append("\nDOCUMENT TYPES (id:document-type/<code>)")
        for r in self.rows("SELECT ?n ?l WHERE { ?t a nvf:DocumentType ; skos:notation ?n ; skos:prefLabel ?l } ORDER BY ?n"):
            L.append(f"- {r['n']}  {r['l']}")
        L.append("\nPOSTING KEYS (id:posting-key/<code>): code, meaning, side, account type")
        for r in self.rows("SELECT ?n ?l ?s ?t WHERE { ?k a nvf:PostingKey ; skos:notation ?n ; skos:prefLabel ?l ; nvf:postingSide ?s ; nvf:accountType ?t } ORDER BY ?n"):
            L.append(f"- {r['n']}  {r['l']}  {short(r['s'])}  {short(r['t'])}")
        L.append("\nPAYMENT TERMS (individuals of nvf:PaymentTerms)")
        for r in self.rows("SELECT ?t ?d ?l WHERE { ?t a nvf:PaymentTerms ; nvf:netDays ?d OPTIONAL { ?t skos:prefLabel ?l } } ORDER BY ?d"):
            L.append(f"- {short(r['t'])}  net {r['d']} days" + (f"  {r['l']}" if r['l'] else ""))
        L.append("\nTAX CODES (individuals of nvf:InputTaxCode / nvf:OutputTaxCode; nvf:taxRate in percent)")
        for r in self.rows("SELECT ?t ?c ?r ?l WHERE { ?t a ?c ; nvf:taxRate ?r . OPTIONAL { ?t rdfs:label ?l } FILTER(?c IN (nvf:InputTaxCode, nvf:OutputTaxCode)) } ORDER BY ?t"):
            L.append(f"- {short(r['t'])}  {short(r['c'])}  {r['r']}%  {r['l'] or ''}")
        L.append("\nDEBT AGE BUCKETS (individuals of nvf:DebtAgeBucket; nvf:minDaysOverdue, nvf:maxDaysOverdue)")
        for r in self.rows("SELECT ?b ?lo ?hi ?l WHERE { ?b a nvf:DebtAgeBucket . OPTIONAL { ?b nvf:minDaysOverdue ?lo } OPTIONAL { ?b nvf:maxDaysOverdue ?hi } OPTIONAL { ?b rdfs:label ?l } } ORDER BY ?lo"):
            L.append(f"- {short(r['b'])}  {(r['lo'] or 'up to') if r['lo'] else 'up to'}{'..' if r['lo'] else ' '}{r['hi'] if r['hi'] else 'and more'} days  {r['l'] or ''}")
        L.append("\nCOST CENTER CATEGORIES: nvf:Administration, nvf:Sales, nvf:Service.  ACCOUNT TYPES of a line item: nvf:CustomerAccountType, nvf:PayeeAccountType, nvf:GLAccountType.  RATE DERIVATION: nvf:DirectRate, nvf:InverseRate, nvf:CrossRate.")
        L.append("\nG/L ACCOUNTS (id:account/<code>; English name; class)")
        for r in self.rows("""SELECT ?i ?l ?c WHERE { ?a a nvf:GLAccount ; dcterms:identifier ?i ; skos:prefLabel ?l . FILTER(LANG(?l) = 'en')
              OPTIONAL { ?a a ?c . FILTER(?c IN (nvf:BalanceSheetAccount, nvf:ProfitAndLossAccount, nvf:ReceivablesAccount, nvf:PayablesAccount)) } } ORDER BY ?i"""):
            L.append(f"- {r['i']}  {r['l']}  {short(r['c']) if r['c'] else ''}")
        L.append("\nCOST CENTERS (id:cost-center/<code>; company; name)")
        for r in self.rows("SELECT ?i ?l ?co WHERE { ?c a nvf:CostCenter ; dcterms:identifier ?i ; org:unitOf/dcterms:identifier ?co OPTIONAL { ?c skos:prefLabel ?l } } ORDER BY ?co ?i"):
            L.append(f"- {r['i']}  company {r['co']}  {r['l'] or ''}")
        # worked examples
        L.append("\nWORKED EXAMPLES: the five competency questions and the queries that answer them (they run correctly on this graph; reuse their patterns)")
        for f in sorted(self.queries_folder.glob("*.rq")):
            L.append(f"\n```sparql\n{f.read_text(encoding='utf-8').strip()}\n```")
        return "\n".join(L)

    # ------------------------------------------------------------ prompts
    def user_prompt(self, question, previous=None, error=None):
        if previous:
            return (f"Question: {question}\n\nYour previous query:\n```sparql\n{previous}\n```\n\nIt failed with this error:\n{error}\n\n"
                    "Fix the query and answer again in the same format (one ```sparql block, then one or two sentences).")
        return f"Question: {question}"

    def full_prompt(self, question, previous=None, error=None):
        """Everything in one text, for the engines that take a single prompt (stdin, or a chat window)."""
        return self.system + "\n\n=====\n" + self.user_prompt(question, previous, error)

    # ------------------------------------------------------------ checks
    def check(self, sparql):
        warnings = []
        for name in sorted(set(re.findall(r"\bnvf:([A-Za-z_][\w]*)", sparql))):
            if name not in self.terms:
                near = [t for t in self.terms if t.lower() == name.lower() or t.lower().startswith(name.lower()[:6])][:3]
                warnings.append(f"nvf:{name} is not in the ontology" + (f" (did you mean {', '.join('nvf:' + n for n in near)}?)" if near else ""))
        for name in sorted(set(re.findall(r"<" + re.escape(NVF) + r"([^>]+)>", sparql))):
            if name not in self.terms:
                warnings.append(f"<{NVF}{name}> is not in the ontology")
        if re.search(r"\b(INSERT|DELETE|LOAD|CLEAR|DROP|SERVICE)\b", re.sub(r"(?m)^\s*#.*$", "", sparql), re.I):
            warnings.append("The query contains an update or SERVICE keyword; it will be rejected")
        return warnings


def extract(answer):
    """-> (sparql or None, explanation, cannot_answer reason or None)"""
    m = re.search(r"```(?:sparql|SPARQL|sql)?\s*\n(.*?)```", answer, re.S)
    sparql = m.group(1).strip() if m else None
    rest = (answer[m.end():] if m else answer).strip()
    cant = re.search(r"#\s*CANNOT_ANSWER:\s*(.*)", answer)
    if cant:
        return None, re.sub(r"(?m)^\s*#\s*CANNOT_ANSWER:.*$", "", answer).strip(), cant.group(1).strip()
    if sparql is None and re.match(r"\s*(PREFIX|SELECT|ASK)\b", answer, re.I):
        sparql, rest = answer.strip(), ""
    return sparql, rest, None


class Claude:
    """Claude Code in print mode. No API key: it uses the person's own Claude login."""
    DISALLOWED = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "NotebookEdit", "TodoWrite"]

    def __init__(self, command="claude", model=None, use_api_key=False, timeout=240):
        self.path = shutil.which(command) or (command if Path(command).is_file() else None)
        self.model = model
        self.use_api_key = use_api_key
        self.timeout = timeout
        self.version = None
        self.lock = threading.Lock()
        if self.path:
            try:
                out = subprocess.run([self.path, "--version"], capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace")
                self.version = (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr).strip() else "unknown version"
            except Exception:
                self.path = None

    @property
    def available(self):
        return bool(self.path)

    def status(self):
        return {"available": self.available, "version": self.version, "model": self.model or "default of Claude Code", "uses_api_key": self.use_api_key}

    def ask(self, prompt):
        if not self.available:
            raise RuntimeError("Claude Code was not found on this computer (the 'claude' command).")
        flags = ["--output-format", "text", "--no-session-persistence", "--disable-slash-commands", "--disallowedTools", *self.DISALLOWED]
        if self.model:
            flags += ["--model", self.model]
        env = dict(os.environ)
        if not self.use_api_key:                          # use the subscription login, not a pay-per-use key
            env.pop("ANTHROPIC_API_KEY", None)
        with self.lock, tempfile.TemporaryDirectory(prefix="nordvia-ask-") as cwd:
            for _ in range(6):                            # drop an option an older version does not know
                proc = subprocess.run([self.path, "-p", *flags], input=prompt, capture_output=True, text=True, encoding="utf-8",
                                      errors="replace", timeout=self.timeout, cwd=cwd, env=env)
                text = (proc.stdout or "").strip()
                err = (proc.stderr or "").strip()
                bad = re.search(r"unknown option '(--[\w-]+)'", err + " " + text)
                if proc.returncode != 0 and bad and bad.group(1) in flags:
                    i = flags.index(bad.group(1))
                    j = i + 1
                    while j < len(flags) and not flags[j].startswith("--"):
                        j += 1
                    del flags[i:j]
                    continue
                break
        if proc.returncode != 0 or not text:
            raise RuntimeError((text or err or f"Claude Code exited with code {proc.returncode}")[:800])
        return text


def answer(pack, claude, question, previous=None, error=None):
    t0 = time.time()
    raw = claude.ask(pack.full_prompt(question, previous, error))
    sparql, explanation, cannot = extract(raw)
    out = {"sparql": sparql, "explanation": explanation, "cannot_answer": cannot, "raw": raw,
           "warnings": pack.check(sparql) if sparql else [], "seconds": round(time.time() - t0, 1),
           "prompt_tokens_estimate": len(pack.full_prompt(question)) // 4}
    return out
