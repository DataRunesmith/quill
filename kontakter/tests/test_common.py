import quill_common as pc


def test_normalize_party_fullname_to_abbr():
    assert pc.normalize_party("Socialdemokraterna") == "S"
    assert pc.normalize_party("moderata samlingspartiet") == "M"
    assert pc.normalize_party("Miljöpartiet de gröna") == "MP"
    assert pc.normalize_party("Medborgerlig Samling") == "MED"


def test_normalize_party_case_aliases():
    assert pc.normalize_party("m") == "M"
    assert pc.normalize_party("Kd") == "KD"
    assert pc.normalize_party("sd") == "SD"
    assert pc.normalize_party("Mp") == "MP"
    assert pc.normalize_party("SiV") == "SIV"
    assert pc.normalize_party("PfE") == "PFE"


def test_normalize_party_invalid_status_values():
    for value in ("-", "--", "SAKNAS", "opol", "Opol.", "Ober", "Oberoende", "-, fd SD"):
        assert pc.normalize_party(value) is None


def test_normalize_party_eu_groups_and_passthrough():
    assert pc.normalize_party("ecr") == "ECR"
    assert pc.normalize_party("renew") == "Renew"
    assert pc.normalize_party("verts/ale") == "Verts/ALE"
    assert pc.normalize_party("Lokalt Parti") == "Lokalt Parti"
    assert pc.normalize_party("24:7") == "24:7"
    assert pc.normalize_party(None) is None
    assert pc.normalize_party("   ") is None


def test_party_from_parens_only_at_end():
    assert pc.party_from_parens("David Johansson (C)") == "C"
    assert pc.party_from_parens("Anna (S), ordförande") is None


def test_party_anywhere():
    assert pc.party_anywhere("Anna (S), ordförande") == "S"
    assert pc.party_anywhere("Bo Ek (Socialdemokraterna) vice") == "S"
    assert pc.party_anywhere("Inget parti här") is None
