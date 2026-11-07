import pytest

import sync_to_d1 as s


def test_area_type_for():
    assert s.area_type_for("Region Skåne") == "region"
    assert s.area_type_for("Sveriges riksdag") == "riksdag"
    assert s.area_type_for("Justitiedepartementet") == "regering"
    assert s.area_type_for("Regeringen") == "regering"
    assert s.area_type_for("Lysekils kommun") == "kommun"


def test_vastra_gotalandsregionen_is_a_region_despite_its_name():
    assert s.area_type_for("Västra Götalandsregionen") == "region"


def test_every_configured_region_classifies_as_a_region():
    for name in sorted(s.REGION_NAMES):
        assert s.area_type_for(name) == "region", name
    assert len(s.REGION_NAMES) == 21


def test_parse_csv_ignores_detailed_role(tmp_path):
    csv_path = tmp_path / "resultat.csv"
    csv_path.write_text(
        "area_name,name,email,party,role,source\n"
        "Lysekils kommun,Anna Ek,anna@kommun.example,S,Ordförande,scraped\n"
        "Lysekils kommun,,info@kommun.example,,,scraped\n"
        "Region Skåne,Bo Vik,bo@region.example,,Ersättare,pattern-guess\n",
        encoding="utf-8",
    )
    rows = s.parse_csv(str(csv_path))
    assert ("Anna Ek", "anna@kommun.example", "Lysekils kommun", "kommun", "S") in rows
    assert ("", "info@kommun.example", "Lysekils kommun", "kommun", None) in rows
    assert ("Bo Vik", "bo@region.example", "Region Skåne", "region", None) in rows


def test_load_rows_reads_csv(tmp_path, monkeypatch):
    csv_path = tmp_path / "r.csv"
    csv_path.write_text("area_name,name,email,party,role,source\nX kommun,A B,a@x.example,,,scraped\n", encoding="utf-8")
    monkeypatch.setattr(s, "RESULTAT_CSV", str(csv_path))
    assert s.load_rows() == [("A B", "a@x.example", "X kommun", "kommun", None)]


def test_load_rows_exits_when_csv_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(s, "RESULTAT_CSV", str(tmp_path / "missing.csv"))
    with pytest.raises(SystemExit):
        s.load_rows()
