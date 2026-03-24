# -*- coding: utf-8 -*-
"""Backward-compatible module alias for visualization artifact manager."""

import sys

from tools.artifacts import visualization_artifact_manager as _impl

sys.modules[__name__] = _impl
