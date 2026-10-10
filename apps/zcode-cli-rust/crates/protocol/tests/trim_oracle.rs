use serde_json::Value;
use zcode_cli_schema::Node;

const FIXTURE: &str = include_str!("fixtures/ts-command-trim-oracle.json");

#[test]
fn every_typescript_trim_leaf_matches_the_production_schema_pipeline() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("trim oracle fixture is JSON");
    let leaves = fixture["leaves"].as_array().expect("trim leaves");
    assert_eq!(fixture["uniquePaths"].as_u64(), Some(63));
    assert_eq!(fixture["leafBranches"].as_u64(), Some(leaves.len() as u64));

    let mut case_count = 0usize;
    for leaf in leaves {
        let path = leaf["path"].as_str().expect("leaf path");
        let branch = leaf["branch"].as_u64().expect("branch ordinal");
        let schema = Node::compile(&leaf["schema"]).expect("generated leaf schema compiles");
        let cases = leaf["cases"].as_array().expect("leaf cases");
        assert_eq!(cases.len(), 5, "{path} branch {branch}");
        for case in cases {
            case_count += 1;
            let raw = Value::String(case["raw"].as_str().expect("raw string").to_owned());
            let expected_ok = case["ok"].as_bool().expect("expected parse result");
            let normalized = schema.normalize(&raw).expect("normalization succeeds");
            let result = schema.validate(&normalized, "");
            assert_eq!(
                result.is_ok(),
                expected_ok,
                "{path} branch {branch}, raw {:?}: {result:?}",
                case["raw"]
            );
            if expected_ok {
                assert_eq!(
                    schema.strip(&normalized),
                    case["parsed"],
                    "{path} branch {branch}, raw {:?}",
                    case["raw"]
                );
            }
        }
    }
    assert_eq!(case_count, leaves.len() * 5);
}
