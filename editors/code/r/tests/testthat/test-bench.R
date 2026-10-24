median_ms <- function(code, n) {
  times <- purrr::map_dbl(seq_len(n), \(i) {
    start <- proc.time()[["elapsed"]]
    code(i)
    (proc.time()[["elapsed"]] - start) * 1000
  })
  stats::median(times)
}

test_that("warm rebuild of one changed small file (logged; strict with ROZONE_BENCH_STRICT=1)", {
  strict <- identical(Sys.getenv("ROZONE_BENCH_STRICT"), "1")
  state <- new_state()
  quiet(handle_build(
    list(files = list(file_spec("/t.R", example_script_text()))),
    state
  ))
  warm <- median_ms(
    \(i) {
      handle_build(
        list(
          files = list(file_spec(
            "/t.R",
            example_script_text(),
            hash = paste("h", i)
          ))
        ),
        state
      )
    },
    n = 15
  )
  message(sprintf(
    "[bench] warm single-file rebuild, no install: %.1f ms (median of 15)",
    warm
  ))
  hit <- median_ms(
    \(i) {
      handle_build(
        list(
          files = list(file_spec("/t.R", example_script_text(), hash = "h 1"))
        ),
        state
      )
    },
    n = 15
  )
  message(sprintf("[bench] fully cached build: %.1f ms", hit))
  if (strict) {
    expect_lt(warm, 100)
  } else {
    succeed()
  }
})

test_that("install build timing is logged", {
  lib_root <- withr::local_tempdir()
  state <- new_state()
  elapsed <- median_ms(
    \(i) {
      quiet(handle_build(
        list(
          files = list(file_spec(
            "/t.R",
            example_script_text(),
            hash = paste("i", i)
          )),
          install = TRUE,
          lib_root = lib_root
        ),
        state
      ))
    },
    n = 3
  )
  message(sprintf(
    "[bench] single-file rebuild with install: %.0f ms (median of 3)",
    elapsed
  ))
  succeed()
})
