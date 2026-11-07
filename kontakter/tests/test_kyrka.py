import fetch_kyrka as fk


def test_clean_name_strips_group_area_and_title():
    assert fk.clean_name("Kajsa Berg (posk)") == "Kajsa Berg"
    assert fk.clean_name("Amanda Carlshamre (POSK) Stockholms stift") == "Amanda Carlshamre Stockholms stift"
    assert fk.clean_name("Wanja Lundby-Wedin (S), Stockholms stift") == "Wanja Lundby-Wedin"
    assert fk.clean_name("Biskop Karin Johannesson") == "Karin Johannesson"
    assert fk.clean_name("Roberth .Krantz (s)") == "Roberth Krantz"  # källslarv med " ."


def test_role_from_classifies_ordforande_variants():
    assert fk.role_from("Stiftsstyrelsen (ordförande), Uppsala stift") == "Ordförande"
    assert fk.role_from("1:e vice ordförande kyrkostyrelsen") == "1:e vice ordförande"
    assert fk.role_from("2:e vice ordförande i kyrkostyrelsen") == "2:e vice ordförande"
    assert fk.role_from("Stiftsstyrelsens arbetsutskott (vice ordförande)") == "Vice ordförande"
    assert fk.role_from("Stiftsstyrelsen (ersättare), Uppsala stift") == "Ersättare"
    assert fk.role_from("Ledamot i kyrkostyrelsen, Svenska kyrkan") == "Ledamot"


def test_extract_parses_person_and_skips_staff():
    lines = [
        "Kajsa Berg (posk)",
        "Stiftsstyrelsen, Uppsala stift",
        "E-post:",
        "kajsa.berg@kyrkan.example",
        # personal: uppdragsraden saknar styrelse-nyckelord -> filtreras bort
        "Ninni Eketrä",
        "Direkt:",
        "E-post:",
        "ninni.eketra@kyrkan.example",
        # kansliets allmänna adress: föregås inte av "E-post:" + person -> bort
        "Box 1314, 75143 Uppsala",
        "Telefon:",
        "uppsalastift@kyrkan.example",
    ]
    rows = fk.extract(lines, "Uppsala stift")
    assert rows == [("Kajsa Berg", "kajsa.berg@kyrkan.example", "POSK", "Ledamot")]


def test_extract_requires_email_line_preceded_by_epost_label():
    # Mejl utan föregående "E-post:"-etikett (t.ex. löpande text) tas inte med.
    lines = ["Någon Person", "Stiftsstyrelsen", "kontakt: nagon@kyrkan.example", "nagon@kyrkan.example"]
    assert fk.extract(lines, "Lunds stift") == []
