import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.helpers import Env  # noqa: E402


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)
