# Mappings

Mappings from the gold tables to the ontology.

Files:
- [nordvia.yarrrml.yml](nordvia.yarrrml.yml): YARRRML mappings, one block per gold table.
- [config.ini](config.ini): Morph-KGC configuration (input `gold/`, output `kg/nordvia-kg.nt`).

To run it, from the project root:

```bash
python -m morph_kgc mappings/config.ini
```

**Note**: notebook 04 runs the same mappings and also checks the graph and saves it in Turtle.
