PYTHON ?= python
NPM ?= npm

.PHONY: backend-compile backend-pycompile backend-test frontend-build check

backend-compile:
	$(PYTHON) -m compileall backend-fastapi

backend-pycompile:
	$(PYTHON) -m py_compile backend-fastapi/main.py

backend-test:
	cd backend-fastapi && $(PYTHON) -m pytest --basetemp=.pytest-tmp agents/tests/

frontend-build:
	cd frontend-client && $(NPM) run build

check: backend-compile backend-pycompile backend-test frontend-build
