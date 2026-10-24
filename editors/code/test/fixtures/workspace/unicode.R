#' Größe in 日本語 — mean of 你好
#'
#' Emoji 🎉 in the description must not shift offsets.
#'
#' @param zahl Eine Zahl (ä ö ü).
#' @param 名前 The name.
grosse <- function(zahl, 名前 = "x") {
  paste(zahl, 名前)
}

# 🎉🎉🎉 astral characters before the call
grosse(1, "é")
