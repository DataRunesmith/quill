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

@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "http://127.0.0.1/",
        "http://127.1/",
        "http://2130706433/",
        "http://[::1]/",
        "http://169.254.169.254/latest/meta-data/",
        "http://metadata.google.internal/",
        "https://service.local/",
        "https://example.org:8443/",
        "https://user:pass@example.org/",
    ],
)
def test_is_safe_network_url_rejects_local_and_nonstandard_targets(url):
    assert not sc.is_safe_network_url(url)


def test_profile_urls_must_stay_on_the_trusted_https_host():
    allowed = sc.trusted_profile_hosts("https://www.netpublicator.com/elected/list")
    assert sc.is_trusted_profile_url("https://netpublicator.com/politician/1", allowed)
    assert not sc.is_trusted_profile_url("https://evil.example/politician/1", allowed)
    assert not sc.is_trusted_profile_url("http://www.netpublicator.com/politician/1", allowed)
