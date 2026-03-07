PYTHON ?= python3

.PHONY: runtime-strict-audit runtime-strict-check

runtime-strict-audit:
	$(PYTHON) backend/scripts/runtime_strict_audit.py

runtime-strict-check:
	$(PYTHON) backend/scripts/runtime_strict_audit.py --check-container-only
