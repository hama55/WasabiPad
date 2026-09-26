\version "2.26.0"
\include "shared-settings.ily"

\header {
  title = "Single"
}

\score {
  \new Staff \relative c' {
    \globalSettings
    c4 d e f
    g4 a b c
  }
  \layout { }
  \midi { }
}
