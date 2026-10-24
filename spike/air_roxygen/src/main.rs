use air_r_parser::RParserOptions;
use air_roxygen_spike::{documented_functions, enclosing_call};
use biome_rowan::TextSize;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: air_roxygen_spike <file.R> [byte-offset]");
    let offset: Option<u32> = args.next().map(|x| x.parse().expect("offset must be an integer"));
    let contents = std::fs::read_to_string(&path).expect("readable file");

    for doc in documented_functions(&contents) {
        println!("{doc:#?}");
    }

    if let Some(offset) = offset {
        let parsed = air_r_parser::parse(&contents, RParserOptions::default());
        let call = enclosing_call(&parsed.syntax(), TextSize::from(offset));
        println!("call at {offset}: {:?}", call.map(|(name, i)| format!("{name}, argument #{i}")));
    }
}
