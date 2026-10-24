# the example script yields the expected topic

    Code
      cat(jsonlite::toJSON(topic, auto_unbox = TRUE, null = "null", pretty = TRUE))
    Output
      {
        "name": "wmean",
        "aliases": ["wmean"],
        "title": "Weighted mean of a column",
        "description_md": "Computes a weighted mean, dropping `NA` pairs.",
        "details_md": null,
        "params": [
          {
            "name": "x",
            "md": "A numeric vector."
          },
          {
            "name": "w",
            "md": "Weights, the same length as `x`."
          }
        ],
        "returns_md": "A length-1 double.",
        "sections": [],
        "examples": "wmean(1:3, c(1, 1, 2))",
        "inherited_from": []
      }

