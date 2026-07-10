NPM ?= npm

.PHONY: packages-check backend-check frontend-check widget-check check

packages-check:
	$(NPM) run check:packages

backend-check:
	$(NPM) run check:backend

frontend-check:
	$(NPM) run check:frontend

widget-check:
	$(NPM) run check:widget

check: packages-check backend-check frontend-check widget-check
