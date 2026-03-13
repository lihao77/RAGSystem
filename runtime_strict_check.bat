@echo off
python -m compileall backend-fastapi
python -m py_compile backend-fastapi\main.py
