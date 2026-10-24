
# Description
This repo is a re-implementation of the y2clerk package by y2analytics. This package is meant to work with a wide variety of in-memory and on-disk formats.

Results should be identical across backends (with the exception of the data type). Lazy data structures stay lazy and don't execute until somethiing forces it to. This allows the backends to optimize freq/freqs the same as other sql or dplyr verbs.

# Development
Commit frequently. Commit messages should be no longer than 1 sentance.
Use Subagents and work in parallel when possible. Use Haiku 5.5 for small or medium sized tasks, or tasks that are easily verifiable, or for exploring a codebase. 
Use Sonnet 5.5 for large or complex changes. 
