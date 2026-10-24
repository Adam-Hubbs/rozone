mod common;

macro_rules! fixture_snapshots {
    ($($name:ident => $file:literal),* $(,)?) => {
        $(
            #[test]
            fn $name() {
                insta::assert_snapshot!(common::report($file));
            }
        )*
    };
}

fixture_snapshots! {
    basic => "basic.R",
    calls => "calls.R",
    inherit => "inherit.R",
    describe_in => "describe.R",
    rdname => "rdname.R",
    strip => "strip.R",
    assignments => "assignments.R",
    blocks => "blocks.R",
    links => "links.R",
    unicode => "unicode.R",
    broken => "broken.R",
}
