"""
Centralized path configuration for the Signal Bridge.
All workspace paths should be imported from here.
"""
import os

WORKSPACE_ROOT = os.getenv('WORKSPACE_ROOT', os.path.expanduser('~/choom-projects'))
