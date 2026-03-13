PYTHON ?= python3

.PHONY: backend-fastapi-check backend-fastapi-compile

backend-fastapi-compile:
	$(PYTHON) -m compileall backend-fastapi

backend-fastapi-check:
	$(PYTHON) -m py_compile backend-fastapi/main.py
