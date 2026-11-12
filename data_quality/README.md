# Data quality

Data quality log of the input tables: 21 findings (4 high, 6 medium, 11 low impact).

Files:
- [data_quality_log.csv](data_quality_log.csv): one row per finding, with what it is, its impact and the proposed action.
- [data_quality_detail.csv](data_quality_detail.csv): the affected rows of each finding.
- [reviewed_and_accepted.csv](reviewed_and_accepted.csv): cases reviewed and accepted as correct.

To regenerate them, run `notebooks/01_data_quality.ipynb`.

**Note**: notebook 02 checks that each finding is flagged on exactly the rows the log reports.
