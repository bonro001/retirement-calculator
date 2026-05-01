use flight_engine::candidate_engine::handle_request;
use serde_json::Value;
use std::env;
use std::io::{self, BufRead, Read, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::args().any(|arg| arg == "--stdio-loop") {
        let stdin = io::stdin();
        let mut stdout = io::stdout();
        for line in stdin.lock().lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let request: Value = serde_json::from_str(&line)?;
            let response = handle_request(&request)?;
            writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
            stdout.flush()?;
        }
        return Ok(());
    }

    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: Value = serde_json::from_str(&input)?;
    let response = handle_request(&request)?;
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}
