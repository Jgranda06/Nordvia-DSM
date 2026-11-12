# Knowledge graph

RDF graph generated from the gold tables with the mappings (about 119,000 triples of data).

Files:
- [nordvia-kg.ttl](nordvia-kg.ttl): the graph in Turtle. Instances are minted under `https://nordvia.com/id/` from the SAP keys.

To rebuild it, run `notebooks/04_knowledge_graph.ipynb` (or the Morph-KGC command in `mappings/`).

**Note**: the file holds data only. Load it together with `ontology/nordvia-finance.ttl`.
