# Notebooks

The pipeline from the SAP tables to the answers, one notebook per step. Each one starts by moving to the project root, so it can be run from this folder or from the root.

Files:
- [01_data_quality.ipynb](01_data_quality.ipynb): data quality assessment of the 11 tables. Writes `data_quality/`.
- [02_silver.ipynb](02_silver.ipynb): typed tables with one flag per finding of the log. Reads `data/`, writes `silver/`.
- [03_gold.ipynb](03_gold.ipynb): one table per class of the ontology, plus the exchange rates to euros. Reads `silver/`, writes `gold/`.
- [04_knowledge_graph.ipynb](04_knowledge_graph.ipynb): runs the mappings over `gold/`, checks the graph and saves `kg/nordvia-kg.ttl`.
- [05_competency_questions.ipynb](05_competency_questions.ipynb): the five SPARQL queries, their results and the assumptions. Saves `queries/results/`.

To run it, install the requirements and run the notebooks in order (01 is optional, its output is already included):

```bash
pip install -r requirements.txt
pip install jupyterlab
jupyter lab notebooks/
```

**Note**: `silver/` is not included in the repository; notebook 02 generates it.
