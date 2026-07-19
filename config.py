import os
import pyqtgraph as pg
from dotenv import load_dotenv

# Hydrate the environmental space
load_dotenv()

TOKEN_FILE = "token.json"
PREFS_FILE = "preferences.json"

# Configure visual canvas styles globally
pg.setConfigOption('background', '#1c1c1c')
pg.setConfigOption('foreground', '#d1d1d1')
