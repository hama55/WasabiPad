// お気に入りの永続化。旧bmbar.rsと同一のタブインデント形式
// (l\t名前\tパス / g\t名前、子は深さ+1) を維持し既存データを引き継ぐ
use serde::{Deserialize, Serialize};
use std::io;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Node {
    File { name: String, path: String },
    Directory { name: String, path: String },
    Group { name: String, children: Vec<Node> },
}

fn store_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
        .join("petapad_bookmarks.txt")
}

fn serialize_into(nodes: &[Node], depth: usize, out: &mut String) {
    for n in nodes {
        for _ in 0..depth {
            out.push('\t');
        }
        match n {
            Node::File { name, path } => out.push_str(&format!("f\t{}\t{}\n", name, path)),
            Node::Directory { name, path } => out.push_str(&format!("d\t{}\t{}\n", name, path)),
            Node::Group { name, children } => {
                out.push_str(&format!("g\t{}\n", name));
                serialize_into(children, depth + 1, out);
            }
        }
    }
}

// path は常に Group を指す (parse が push 直後の添字のみ積むため)
fn descend<'a>(mut list: &'a mut Vec<Node>, path: &[usize]) -> &'a mut Vec<Node> {
    for &i in path {
        match list.get_mut(i) {
            Some(Node::Group { children, .. }) => list = children,
            _ => unreachable!(),
        }
    }
    list
}

fn parse(text: &str) -> Vec<Node> {
    let mut root: Vec<Node> = Vec::new();
    // stack[d] = 深さdの親グループへのインデックス経路
    let mut path_stack: Vec<usize> = Vec::new();
    for line in text.lines() {
        let depth = line.bytes().take_while(|&b| b == b'\t').count();
        let body = &line[depth..];
        let mut it = body.split('\t');
        let kind = it.next().unwrap_or("");
        let node = match kind {
            "l" | "f" | "d" => {
                let name = it.next().unwrap_or("").to_string();
                let p = it.next().unwrap_or("").to_string();
                if kind == "d" || (kind == "l" && PathBuf::from(&p).is_dir()) {
                    Node::Directory { name, path: p }
                } else {
                    Node::File { name, path: p }
                }
            }
            "g" => Node::Group {
                name: it.next().unwrap_or("").to_string(),
                children: Vec::new(),
            },
            _ => continue,
        };
        path_stack.truncate(depth);
        let list = descend(&mut root, &path_stack);
        let is_group = matches!(node, Node::Group { .. });
        list.push(node);
        if is_group {
            path_stack.push(list.len() - 1);
        }
    }
    root
}

pub fn load() -> Vec<Node> {
    std::fs::read_to_string(store_path())
        .map(|t| parse(&t))
        .unwrap_or_default()
}

pub fn save(nodes: &[Node]) -> io::Result<()> {
    let mut out = String::new();
    serialize_into(nodes, 0, &mut out);
    std::fs::write(store_path(), out)
}
