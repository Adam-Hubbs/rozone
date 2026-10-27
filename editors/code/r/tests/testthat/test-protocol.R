test_that("hello comes first with versions and an empty missing array", {
  session <- start_sidecar()
  line <- read_line(session)
  hello <- jsonlite::fromJSON(line, simplifyVector = FALSE)
  expect_identical(hello$event, "hello")
  expect_identical(hello$protocol, 1L)
  expect_true(hello$ok)
  expect_identical(hello$missing, list())
  expect_match(line, "\"missing\":[]", fixed = TRUE)
  expect_identical(
    hello$r_version,
    paste(R.version$major, R.version$minor, sep = ".")
  )
  expect_identical(
    hello$packages$roxygen2,
    as.character(utils::packageVersion("roxygen2"))
  )
  expect_identical(
    hello$packages$jsonlite,
    as.character(utils::packageVersion("jsonlite"))
  )
})

test_that("a missing package gives ok:false and exit status 3", {
  session <- start_sidecar(c(
    ROZONE_SIDECAR_REQUIRE = "roxygen2,jsonlite,notapkg.zzz"
  ))
  hello <- read_message(session)
  expect_false(hello$ok)
  expect_identical(hello$missing, list("notapkg.zzz"))
  expect_identical(wait_for_exit(session), 3L)
})

test_that("ping, ids and ordering", {
  session <- start_sidecar()
  read_message(session)
  send_line(session, request_line(7, "ping"))
  send_line(session, request_line("abc", "ping"))
  send_line(session, request_line(9, "ping"))
  replies <- purrr::map(1:3, \(i) read_message(session))
  expect_identical(purrr::map(replies, "id"), list(7L, "abc", 9L))
  expect_true(all(purrr::map_lgl(replies, \(r) r$result$pong)))
})

test_that("malformed lines get an error with a null id and the process lives", {
  session <- start_sidecar()
  read_message(session)
  send_line(session, "{not json")
  reply <- read_message(session)
  expect_true("id" %in% names(reply))
  expect_null(reply$id)
  expect_type(reply$error$message, "character")
  send_line(session, "[1, 2]")
  expect_null(read_message(session)$id)
  send_line(session, "")
  expect_identical(send_request(session, 1, "ping")$result$pong, TRUE)
  expect_true(session$proc$is_alive())
})

test_that("unknown methods and a missing method are errors", {
  session <- start_sidecar()
  read_message(session)
  reply <- send_request(session, 5, "frobnicate")
  expect_identical(reply$id, 5L)
  expect_match(reply$error$message, "frobnicate")
  send_line(session, "{\"id\": 6}")
  reply <- read_message(session)
  expect_identical(reply$id, 6L)
  expect_false(is.null(reply$error))
})

test_that("a failing handler returns an error and the loop continues", {
  session <- start_sidecar()
  read_message(session)
  reply <- send_request(
    session,
    1,
    "build",
    list(files = list(list(hash = "x")))
  )
  expect_false(is.null(reply$error))
  expect_identical(send_request(session, 2, "ping")$result$pong, TRUE)
})

test_that("build works from text and from disk", {
  session <- start_sidecar()
  read_message(session)
  from_text <- send_request(
    session,
    1,
    "build",
    build_params(list(file_spec("/t.R", example_script_text())))
  )
  expect_identical(from_text$result$topics, list("wmean"))
  expect_identical(from_text$result$manifest$version, 1L)

  path <- withr::local_tempfile(fileext = ".R")
  writeLines(example_script_text(), path)
  from_disk <- send_request(
    session,
    2,
    "build",
    build_params(list(list(path = path, hash = "disk")))
  )
  expect_identical(from_disk$result$manifest$files[[1]]$path, path)
  expect_identical(from_disk$result$cache_hits, 0L)
})

test_that("empty and no-topic builds are valid (regression)", {
  session <- start_sidecar()
  read_message(session)
  empty <- send_request(session, 1, "build", build_params(list()))
  expect_null(empty$error)
  expect_identical(empty$result$topics, list())
  expect_identical(empty$result$errors, list())
  expect_identical(empty$result$manifest$files, list())
})

test_that("the shared example script builds through the real process (regression)", {
  example <- test_path(
    "..", "..", "..", "test", "fixtures", "workspace", "example_script.R"
  )
  expect_true(file.exists(example))
  text <- paste(readLines(example, warn = FALSE), collapse = "\n")
  session <- start_sidecar()
  read_message(session)
  reply <- send_request(
    session,
    1,
    "build",
    build_params(list(file_spec("/example.R", text)))
  )
  expect_null(reply$error)
  expect_identical(
    unlist(reply$result$topics),
    c("summarise_wmean", "wmean")
  )
})

test_that("non-ASCII text round-trips, also in the C locale", {
  text <- "#' Café 日本語\n#'\n#' Emoji \U0001F600.\nf <- function() NULL"
  purrr::walk(list(character(), c(LC_ALL = "C")), \(env) {
    session <- start_sidecar(env)
    read_message(session)
    reply <- send_request(
      session,
      1,
      "build",
      build_params(list(file_spec("/u.R", text)))
    )
    topic <- reply$result$manifest$files[[1]]$topics[[1]]
    expect_identical(topic$title, "Café 日本語")
    expect_identical(topic$description_md, "Emoji \U0001F600.")
  })
})

test_that("shutdown replies then exits 0", {
  session <- start_sidecar()
  read_message(session)
  expect_identical(send_request(session, 1, "shutdown")$result$ok, TRUE)
  expect_identical(wait_for_exit(session), 0L)
})

test_that("stdin EOF exits 0 (also without a trailing newline)", {
  input <- withr::local_tempfile()
  cat(request_line(1, "ping"), file = input)
  session <- start_sidecar(stdin = input)
  expect_true(read_message(session)$ok)
  expect_identical(read_message(session)$result$pong, TRUE)
  expect_identical(wait_for_exit(session), 0L)
})

test_that("stdout carries only JSON lines, even during install", {
  lib_root <- withr::local_tempdir()
  input <- withr::local_tempfile()
  writeLines(
    c(
      request_line(
        1,
        "build",
        build_params(
          list(file_spec("/t.R", example_script_text())),
          install = TRUE,
          lib_root = lib_root
        )
      ),
      request_line(2, "ping")
    ),
    input
  )
  session <- start_sidecar(stdin = input)
  expect_identical(wait_for_exit(session, timeout = 120), 0L)
  lines <- session$proc$read_all_output_lines()
  expect_length(lines, 3L)
  expect_true(all(purrr::map_lgl(lines, jsonlite::validate)))
  expect_match(session$proc$read_all_error(), "installing", fixed = TRUE)
})
