//! Knowledge transition and dependency ownership invariants.

use xper_domain::{
    Phase, is_allowed_transition,
    planning::{Node, validate_dag},
};

#[test]
fn knowledge_transitions_have_one_shared_policy_and_never_start_implementation() {
    for (from, to) in [
        (Phase::Discovery, Phase::Define),
        (Phase::Define, Phase::Design),
        (Phase::Design, Phase::Breakdown),
        (Phase::Breakdown, Phase::Plan),
        (Phase::Plan, Phase::Design),
        (Phase::Breakdown, Phase::Define),
    ] {
        assert!(is_allowed_transition(from, to));
    }
    for from in [
        Phase::Intake,
        Phase::Discovery,
        Phase::Define,
        Phase::Design,
        Phase::Breakdown,
        Phase::Plan,
    ] {
        assert!(!is_allowed_transition(from, Phase::Implementation));
        assert!(!is_allowed_transition(from, from));
    }
}

#[test]
fn dependency_order_serializes_shared_resources_and_preserves_safe_parallelism() {
    let a_deps = vec![];
    let b_deps = vec!["a".into()];
    let c_deps = vec!["b".into()];
    let resource = vec!["integration-target".into()];
    let nodes = [
        Node {
            id: "a",
            dependencies: &a_deps,
            workspace: "first",
            resources: &resource,
        },
        Node {
            id: "b",
            dependencies: &b_deps,
            workspace: "second",
            resources: &[],
        },
        Node {
            id: "c",
            dependencies: &c_deps,
            workspace: "first",
            resources: &resource,
        },
    ];
    assert_eq!(validate_dag(&nodes).unwrap(), vec!["a", "b", "c"]);
    let parallel = [
        Node {
            id: "a",
            dependencies: &[],
            workspace: "first",
            resources: &[],
        },
        Node {
            id: "b",
            dependencies: &[],
            workspace: "second",
            resources: &[],
        },
    ];
    assert!(validate_dag(&parallel).is_ok());
    let conflicting = [
        Node {
            id: "a",
            dependencies: &[],
            workspace: "first",
            resources: &resource,
        },
        Node {
            id: "b",
            dependencies: &[],
            workspace: "second",
            resources: &resource,
        },
    ];
    assert!(validate_dag(&conflicting).unwrap_err().contains("conflict"));
}
