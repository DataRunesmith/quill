import pytest

pytest.importorskip("dns.resolver")  # dnspython krävs för att importera modulen
import verify_emails as v


def test_5xx_is_dead():
    assert v._classify(550, is_catchall=False) == "dead"
    assert v._classify(551, is_catchall=False) == "dead"
    assert v._classify(553, is_catchall=False) == "dead"


def test_4xx_is_temporary_not_dead():
    # Regressionsvakt: 450/452 är TILLFÄLLIGA fel (greylisting m.m.) och fick
    # tidigare felaktigt statusen "dead".
    assert v._classify(450, is_catchall=False) == "temporary"
    assert v._classify(452, is_catchall=False) == "temporary"
    assert v._classify(421, is_catchall=False) == "temporary"


def test_2xx_valid_and_catchall():
    assert v._classify(250, is_catchall=False) == "valid"
    assert v._classify(250, is_catchall=True) == "catchall_unverified"


def test_unknown_code():
    assert v._classify(600, is_catchall=False) == "unknown_code_600"
