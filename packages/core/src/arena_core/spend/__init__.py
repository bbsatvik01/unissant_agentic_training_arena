"""The spend guard client: reserve, dispatch, record usage, settle against S4's SQL (S5 4).

`guard.DbSpendGuard` is the runtime guard; `memory.RunBudget` is the unit-test double; `limits` and `rates` mirror
the cost model and S4's formulas for tests and planning (the database computes every amount); `plan` applies and
checks the budget plan (scripts/budget_plan.py).
"""
