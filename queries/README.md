# Queries

One SPARQL query per competency question. Each file starts with the assumptions it uses.

Files:
- [cq1_receivables_by_debt_age.rq](cq1_receivables_by_debt_age.rq): receivables by customer and debt age.
- [cq2_vendor_invoicing.rq](cq2_vendor_invoicing.rq): vendors that invoiced most in 2025, per company.
- [cq3_cost_by_cost_center.rq](cq3_cost_by_cost_center.rq): cost per cost center and expense type.
- [cq4_days_to_pay.rq](cq4_days_to_pay.rq): days to pay against payment terms.
- [cq5_profit_and_loss.rq](cq5_profit_and_loss.rq): profit and loss per company and month.
- [results/](results/): the answers, as CSV.

To run them, execute `notebooks/05_competency_questions.ipynb`, or load the ontology and the graph into any SPARQL engine and run the `.rq` files.

**Note**: amounts are in euros, key date 31 December 2025.
