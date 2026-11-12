# Ontology

OWL ontology of the SAP FI extract of Nordvia Retail: 47 classes in seven domains (organization, accounting documents, postings, business partners, accounts, code lists, currency and exchange rates). Every term has a label and a definition.

Files:
- [nordvia-finance.ttl](nordvia-finance.ttl): the ontology in Turtle. Namespace `https://nordvia.com/ontology/finance#` (`nvf:`).
- [Nordvia.drawio](Nordvia.drawio): diagrams of the model (conceptual schema, usage schema and domains). Open it with [diagrams.net](https://app.diagrams.net/).

**Note**: to query the graph, load this file together with `kg/nordvia-kg.ttl` into the same store; the queries use the class hierarchy and the debt-age buckets defined here.
