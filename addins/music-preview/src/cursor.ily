% Playback metadata stays in generated assets; the source score is unchanged.
#(define wp-cursor-port (open-output-file wp-cursor-file))
#(define wp-score-counter 0)
#(define wp-system-counter 0)
#(define wp-systems (make-hash-table))
#(define (wp-record value)
   (display value wp-cursor-port)
   (newline wp-cursor-port)
   (force-output wp-cursor-port))

#(define (wp-tag-score score)
   (when (ly:score? score)
     (let ((header (if (module? (ly:score-header score)) (ly:score-header score) (make-module)))
           (note-counter 0))
       (set! wp-score-counter (+ wp-score-counter 1))
       (module-define! header 'wp-score-id wp-score-counter)
       (ly:score-set-header! score header)
       (music-map
        (lambda (music)
          (when (memq (ly:music-property music 'name) '(NoteEvent RestEvent MultiMeasureRestMusic))
            (set! note-counter (+ note-counter 1))
            (ly:music-set-property! music 'wp-score-id wp-score-counter)
            (ly:music-set-property! music 'wp-note-id note-counter))
          music)
        (ly:score-music score)))))

#(for-each
   (lambda (symbol)
     (let ((original (ly:parser-lookup symbol)))
       (ly:parser-define! symbol
        (lambda args
          (wp-tag-score (car (reverse args)))
          (apply original args)))))
   '(toplevel-score-handler book-score-handler bookpart-score-handler))

#(define wp-original-performance-write ly:performance-write)
#(module-set! (resolve-module '(lily)) 'ly:performance-write
   (lambda (performance filename name)
     (let ((id (ly:modules-lookup (ly:performance-headers performance) 'wp-score-id)))
       (when (number? id)
         (wp-record (format #f "[\"file\",~a,~s]" id filename))))
     (wp-original-performance-write performance filename name)))

#(define (wp-midi-performer context)
   (make-performer
    (listeners
     ((note-event performer event)
      (wp-midi-event context event))
     ((rest-event performer event)
      (wp-midi-event context event)))))

#(define (wp-midi-event context event)
   (let ((score (ly:event-property event 'wp-score-id #f))
         (note (ly:event-property event 'wp-note-id #f))
         (moment (ly:context-current-moment context)))
     (when (and (number? score) (number? note))
       (wp-record
        (format #f "[\"event\",~a,~a,~a,~a]" score note
         (exact->inexact (ly:moment-main moment))
         (exact->inexact (ly:moment-grace moment)))))))

#(define (wp-annotate grob)
   (let* ((event (ly:grob-property grob 'cause))
          (score (and (ly:stream-event? event) (ly:event-property event 'wp-score-id #f)))
          (note (and (ly:stream-event? event) (ly:event-property event 'wp-note-id #f))))
     (if (and (number? score) (number? note))
       (let* ((system (ly:grob-system grob))
              (id (hashq-ref wp-systems system #f))
              (bounds (ly:grob-extent system system Y))
              (right (cdr (ly:grob-extent system system X)))
              (x (ly:grob-relative-coordinate grob system X))
              (y (ly:grob-relative-coordinate grob system Y)))
         (unless id
           (set! wp-system-counter (+ wp-system-counter 1))
           (set! id wp-system-counter)
           (hashq-set! wp-systems system id))
         `((data-wp-score . ,(number->string score))
           (data-wp-note . ,(number->string note))
           (data-wp-system . ,(number->string id))
           (data-wp-right . ,(number->string (- right x)))
           (data-wp-top . ,(number->string (- y (cdr bounds))))
           (data-wp-height . ,(number->string (- (cdr bounds) (car bounds))))))
       '())))

#(define (wp-layout-engraver context)
   (define (watch grob)
     (let ((moment (ly:context-current-moment context))
           (original (ly:grob-property-data grob 'output-attributes)))
       ;; Read System geometry only when printing, after layout has settled.
       ;; Evaluating its extent during after-line-breaking changes staff placement.
       (ly:grob-set-property! grob 'output-attributes
        (lambda (grob)
          (append (if (procedure? original) (original grob) original)
           `((data-wp-moment . ,(number->string (exact->inexact (ly:moment-main moment)))))
           (wp-annotate grob))))))
   (make-engraver
    (acknowledgers
     ((note-head-interface engraver grob source) (watch grob))
     ((rest-interface engraver grob source) (watch grob)))))

\layout { \context { \Voice \consists #wp-layout-engraver } }
\midi { \context { \Voice \consists #wp-midi-performer } }
