\version "2.26.0"
\include "shared-settings.ily"

\book {
  \header { title = "Alpha" }
  \score {
    \new Staff \relative c' {
      \globalSettings
      \repeat unfold 8 { c4 d e f }
      \pageBreak
      \repeat unfold 8 { g4 a b c }
    }
    \layout { }
    \midi { }
  }
}

\book {
  \header { title = "Beta" }
  \score {
    \new Staff \relative c' {
      \globalSettings
      \repeat unfold 8 { e4 f g a }
      \pageBreak
      \repeat unfold 8 { b4 c d e }
    }
    \layout { }
    \midi { }
  }
}
