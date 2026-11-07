import pytest

# scraper.py importerar playwright/pypdf; hoppa över lokalt om de saknas.
pytest.importorskip("playwright")
pytest.importorskip("pypdf")
import scraper as sc


def test_is_valid_email():
    assert sc.is_valid_email("anna.ek@kommun.example")
    assert not sc.is_valid_email("noreply@kommun.example")   # SKIP_KEYWORDS
    assert not sc.is_valid_email("info@region.example")       # "info@region"
    assert not sc.is_valid_email("inte en adress")


def test_email_from_mailto_href():
    assert sc.email_from_mailto_href("mailto:Anna@Kommun.example") == "anna@kommun.example"
    # url-kodat inledande blanksteg ska strippas
    assert sc.email_from_mailto_href("mailto:%20a@b.example?subject=x") == "a@b.example"


def test_email_local_part_translitteration():
    assert sc._email_local_part("Åsa") == "asa"
    assert sc._email_local_part("Görel") == "gorel"   # å/ä/ö -> a/a/o
    assert sc._email_local_part("André") == "andre"   # é -> e
    assert sc._email_local_part("Per-Erik") == "per-erik"  # bindestreck bevaras


def test_swedish_key_orders_after_z():
    names = ["Öberg", "Andersson", "Ähtävä", "Åberg", "Zetterlund"]
    assert sorted(names, key=sc.swedish_key) == [
        "Andersson", "Zetterlund", "Åberg", "Ähtävä", "Öberg",
    ]


def test_looks_like_name():
    assert sc._looks_like_name("Anna Ek")
    assert not sc._looks_like_name("a@b.example")
    assert not sc._looks_like_name("")
