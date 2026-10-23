use super::*;
use serde_json::json;
use ts_rs::TS;

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("t.db")).unwrap();
    (dir, s)
}

fn node(id: &str, kind: &str, z: i64) -> BoardNode {
    BoardNode {
        id: id.into(),
        kind: kind.into(),
        x: 1.5,
        y: 2.0,
        width: Some(10.0),
        height: None,
        data: json!({"t": id}),
        z,
    }
}

#[test]
fn migrates_from_zero_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("m.db");
    drop(Store::open(&path).unwrap());
    let conn = Connection::open(&path).unwrap();
    let v: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 5);
    let mut tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    tables.sort();
    assert_eq!(
        tables,
        [
            "board_edges",
            "board_nodes",
            "boards",
            "messages",
            "projects",
            "sessions",
            "transcript_cursors",
            "usage"
        ]
    );
    drop(conn);
    Store::open(&path).unwrap();
}

#[test]
fn project_crud_and_reorder() {
    let (_d, s) = store();
    let a = s.create_project("a", "/tmp/a").unwrap();
    let b = s.create_project("b", "/tmp/b").unwrap();
    let c = s.create_project("c", "/tmp/c").unwrap();
    assert_eq!((a.position, b.position, c.position), (0, 1, 2));
    assert!(a.last_opened_at.is_none());
    let u = s.update_project(&a.id, "a2", "/tmp/a2").unwrap();
    assert_eq!((u.name.as_str(), u.path.as_str()), ("a2", "/tmp/a2"));
    assert!(s.touch_project(&a.id).unwrap().last_opened_at.is_some());
    s.reorder_projects(&[c.id.clone(), a.id.clone(), b.id.clone()])
        .unwrap();
    let ids: Vec<_> = s
        .list_projects()
        .unwrap()
        .into_iter()
        .map(|p| p.id)
        .collect();
    assert_eq!(ids, [c.id.clone(), a.id.clone(), b.id.clone()]);
    s.delete_project(&b.id).unwrap();
    assert_eq!(s.list_projects().unwrap().len(), 2);
}

#[test]
fn board_save_and_load() {
    let (_d, s) = store();
    let p = s.create_project("p", "/tmp/p").unwrap();
    assert_eq!(s.load_board(&p.id).unwrap().nodes.len(), 0);
    let edge = BoardEdge {
        id: "e1".into(),
        source: "n1".into(),
        target: "n2".into(),
        data: json!({}),
    };
    s.save_board(
        &p.id,
        &BoardChanges {
            viewport: Some(json!({"x": 1, "y": 2, "zoom": 0.5})),
            upsert_nodes: vec![node("n1", "note", 0), node("n2", "note", 1)],
            upsert_edges: vec![edge.clone()],
            ..Default::default()
        },
    )
    .unwrap();
    let mut moved = node("n1", "note", 5);
    moved.x = 99.0;
    s.save_board(
        &p.id,
        &BoardChanges {
            upsert_nodes: vec![moved.clone()],
            delete_node_ids: vec!["n2".into()],
            ..Default::default()
        },
    )
    .unwrap();
    let b = s.load_board(&p.id).unwrap();
    assert_eq!(b.viewport, json!({"x": 1, "y": 2, "zoom": 0.5}));
    assert_eq!(b.nodes, [moved.clone()]);
    assert!(b.edges.is_empty(), "edges of a deleted node are removed");

    s.save_board(
        &p.id,
        &BoardChanges {
            upsert_nodes: vec![moved.clone()],
            delete_node_ids: vec!["n1".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        s.load_board(&p.id).unwrap().nodes,
        [moved],
        "re-added node survives its delete"
    );
}

#[test]
fn failed_batch_rolls_back() {
    let (_d, s) = store();
    let p = s.create_project("p", "/tmp/p").unwrap();
    let bad = BoardChanges {
        upsert_nodes: vec![node("n1", "note", 0), node("n2", "", 1)],
        ..Default::default()
    };
    assert!(s.save_board(&p.id, &bad).is_err());
    assert!(s.load_board(&p.id).unwrap().nodes.is_empty());
}

#[test]
fn deleting_project_keeps_folder_and_removes_board() {
    let (_d, s) = store();
    let folder = tempfile::tempdir().unwrap();
    std::fs::write(folder.path().join("keep.txt"), "x").unwrap();
    let p = s
        .create_project("p", folder.path().to_str().unwrap())
        .unwrap();
    s.save_board(
        &p.id,
        &BoardChanges {
            upsert_nodes: vec![node("n1", "note", 0)],
            ..Default::default()
        },
    )
    .unwrap();
    s.delete_project(&p.id).unwrap();
    assert!(folder.path().join("keep.txt").exists());
    assert!(s.load_board(&p.id).unwrap().nodes.is_empty());
}

// The committed TS client types must equal what ts-rs generates from the Rust types.
#[test]
fn ts_types_match_rust() {
    let cfg = ts_rs::Config::default();
    let generated: String = [
        Project::export_to_string(&cfg),
        BoardNode::export_to_string(&cfg),
        BoardEdge::export_to_string(&cfg),
        Board::export_to_string(&cfg),
        BoardChanges::export_to_string(&cfg),
        AgentSession::export_to_string(&cfg),
        Usage::export_to_string(&cfg),
    ]
    .map(|r| r.unwrap())
    .join("\n")
    .lines()
    .filter(|l| !l.starts_with("//") && !l.starts_with("import"))
    .filter(|l| !l.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    let generated = format!(
        "// biome-ignore-all lint: generated by ts-rs, see store tests\n// biome-ignore-all format: generated\n\n{generated}\n"
    );
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/store/types.ts");
    if std::env::var("UPDATE_TS_TYPES").is_ok() {
        std::fs::write(path, &generated).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        generated,
        "run with UPDATE_TS_TYPES=1 to regenerate"
    );
}

#[test]
fn message_states_move_forward_and_only_the_recipient_accepts() {
    let (_d, s) = store();
    let p = s.create_project("p", "/tmp/p").unwrap();
    let m = s
        .add_message(&p.id, "exec", "ceo", "report", "done", None)
        .unwrap();
    assert_eq!(
        (m.state.as_str(), m.thread.as_str()),
        ("sent", m.id.as_str())
    );
    assert_eq!(m.delivered_via, None);
    assert_eq!(
        s.undelivered(&p.id, "ceo").unwrap(),
        std::slice::from_ref(&m)
    );

    let w = s.mark_waiting(&m.id, "typed").unwrap().unwrap();
    assert_eq!(
        (w.state.as_str(), w.delivered_via.as_deref()),
        ("waiting", Some("typed"))
    );
    assert!(w.waiting_at.is_some());
    assert_eq!(
        s.mark_waiting(&m.id, "stop").unwrap(),
        None,
        "delivered once"
    );
    assert!(s.undelivered(&p.id, "ceo").unwrap().is_empty());
    assert_eq!(s.inbox(&p.id, "ceo").unwrap(), std::slice::from_ref(&w));

    let e = s.accept_message(&m.id, "exec").unwrap_err();
    assert!(e.contains("not addressed to you"), "{e}");
    assert_eq!(s.message(&m.id).unwrap().unwrap().state, "waiting");
    let a = s.accept_message(&m.id, "ceo").unwrap();
    assert_eq!(a.state, "accepted");
    assert!(a.accepted_at.is_some());
    assert!(
        s.accept_message(&m.id, "ceo")
            .unwrap_err()
            .contains("already accepted")
    );
    assert_eq!(s.mark_waiting(&m.id, "typed").unwrap(), None, "never back");
    assert!(
        s.accept_message("nope", "ceo")
            .unwrap_err()
            .contains("no message")
    );
    assert!(s.inbox(&p.id, "ceo").unwrap().is_empty());

    // The board after a restart: unaccepted ones, and an accepted ask until its reply is accepted.
    let ask = s
        .add_message(&p.id, "exec", "ceo", "ask", "which?", None)
        .unwrap();
    s.accept_message(&ask.id, "ceo").unwrap();
    let reply = s
        .add_message(&p.id, "ceo", "exec", "reply", "this", Some(&ask.thread))
        .unwrap();
    assert_eq!(reply.thread, ask.thread);
    assert_eq!(
        s.reply_in(&ask.thread, "exec").unwrap(),
        Some(reply.clone())
    );
    let ids = |l: Vec<Message>| l.into_iter().map(|m| m.id).collect::<Vec<_>>();
    assert_eq!(
        ids(s.list_messages(&p.id).unwrap()),
        [ask.id.clone(), reply.id.clone()]
    );
    s.accept_message(&reply.id, "exec").unwrap();
    assert!(s.list_messages(&p.id).unwrap().is_empty());
}

#[test]
fn undelivered_messages_survive_a_reopen() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("m.db");
    let s = Store::open(&path).unwrap();
    let p = s.create_project("p", "/tmp/p").unwrap();
    let a = s
        .add_message(&p.id, "ceo", "exec", "send", "a", None)
        .unwrap();
    let b = s
        .add_message(&p.id, "ceo", "exec", "send", "b", None)
        .unwrap();
    s.mark_waiting(&b.id, "post_tool_use").unwrap();
    drop(s);
    let s = Store::open(&path).unwrap();
    assert_eq!(s.undelivered(&p.id, "exec").unwrap(), [a]);
    assert_eq!(s.inbox(&p.id, "exec").unwrap().len(), 2);
    // Messages go with their project.
    s.delete_project(&p.id).unwrap();
    assert!(s.message(&b.id).unwrap().is_none());
}

#[test]
fn refuses_newer_schema() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("db.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .pragma_update(None, "user_version", 999)
        .unwrap();
    assert!(Store::open(&path).is_err());
}
