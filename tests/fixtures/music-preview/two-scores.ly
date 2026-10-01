\version "2.26.0"

\book {
  \score {
    \header { title = "Alpha" }
    \new Staff \relative c' {
      \time 4/4
      c4 d e f
    }
    \layout { }
    \midi { }
  }
  \score {
    \header { title = "Beta" }
    \new Staff \relative c' {
      \time 4/4
      g4 a b c
    }
    \layout { }
    \midi { }
  }
}
