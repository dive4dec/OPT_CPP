// Python Tutor: https://github.com/pgbovine/OnlinePythonTutor/
// Copyright (C) Philip Guo (philip@pgbovine.net)
// LICENSE: https://github.com/pgbovine/OnlinePythonTutor/blob/master/LICENSE.txt


// OPT live programming prototype started on 2016-05-30
// first launched as a "Live Programming Mode" button on main OPT site
// on 2016-06-08, working for Python 2/3 and JavaScript for starters
//
// ... inspired by my explorations with IPython shell + OPT for REPL
// visualizations in August 2013 (opt-ipy.py), and Irene Chen's holistic
// visualizations (2013-2014 UROP), inspired by Bret Victor's stuff

/* TODOs:

- use a backup execution server for JS (via backupHttpServerRoot) just
  like we do in opt-frontend-common.ts

- abstract out components within pytutor.js to prevent ugly code
  duplication with stuff in this file

- if these Ace enhancements look good, then I can also use them for
  Codeopticon as well!

- [later] add a codeopticon-style history slider of the user's past
  edits (but that might be confusing)
  - NB: now we kind of already have this if you're in a shared session
    with 'undo' and 'redo' buttons

- [later] detect exact position of syntax error and put a squiggly line below
  it with something like:

  File "<string>", line 1
    x~=1
     ^

  (do this for the OPT classic editor too. and for other language backends)

*/

require('../css/opt-frontend.css');
require('../css/opt-live.css');

// 2025-03-05: pack webllm.ts to bundle
require('./webllm');

// need to directly import the class for type checking to work

// 2019-04-09: disabled shared sessions in opt-live.ts
//import {OptFrontendSharedSessions,TogetherJS} from './opt-shared-sessions';

import { OptFrontend } from './opt-frontend';
import { ExecutionVisualizer, assert, brightRed, darkArrowColor, lightArrowColor, SVG_ARROW_POLYGON, htmlspecialchars } from './pytutor';
import { allTabsRE } from './opt-frontend';
import { asyncRun } from './pyodide/runner';
import { nullTraceErrorLst } from './footer-html';
import * as d3 from 'd3';
// just punt and use global script dependencies
require("script-loader!./lib/ace/src-min-noconflict/ace.js");
require('script-loader!./lib/ace/src-min-noconflict/mode-c_cpp.js');
// require('script-loader!./lib/ace/src-min-noconflict/mode-javascript.js');
// require('script-loader!./lib/ace/src-min-noconflict/mode-typescript.js');
// require('script-loader!./lib/ace/src-min-noconflict/mode-c_cpp.js');
// require('script-loader!./lib/ace/src-min-noconflict/mode-java.js');
// require('script-loader!./lib/ace/src-min-noconflict/mode-ruby.js');

// const {
//   PYODIDE_VERSION,
// } = require('./common/version.js')


var optLiveFrontend: OptLiveFrontend;

// ── Clickable-error helpers ────────────────────────────────────────────────
// Parse a source line number out of an error message. Catches the worker's
// "crashed at line N", a compile diagnostic "...line N...", "line=N", and a
// bare trailing "line N". Returns -1 when no line is detectable.
function extractErrorLine(text: string): number {
  if (!text) return -1;
  var m;
  // "Runtime error: your program crashed at line 4 ..."
  m = text.match(/crashed at line\s+(\d+)/i);
  if (m) return parseInt(m[1], 10);
  // "line=35" / "line: 35" / "line 35"
  m = text.match(/line\s*[=:]\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  m = text.match(/line\s+(\d+)\b/i);
  if (m) return parseInt(m[1], 10);
  return -1;
}

// Build the HTML shown in #frontendErrorOutput. If `line` is known, the "line N"
// (or a "line N" fragment appended to the message) becomes a clickable link
// (class `err-line-link`, data-line=N) that the live page wires up to jump to
// that step / highlight the line. `advisory` messages (guidance, e.g. "no
// main()") are shown as-is, not styled as an error.
function buildErrorHtml(msg: string, line: number, advisory: boolean): string {
  var safe = htmlspecialchars(msg);
  if (!advisory && line > 0) {
    // Turn the "line N" occurrence (case-insensitive) into a link. If the
    // message doesn't already name a line, append a " (line N)" link.
    var linked = safe.replace(/line\s*[=:]\s*(\d+)\b/i, function (mm, digits) {
      if (parseInt(digits, 10) === line) {
        return 'line <a class="err-line-link" data-line="' + line + '" href="#">' +
          digits + '</a>';
      }
      return mm;
    });
    if (linked === safe) {
      // no "line N" token in the message itself → append one
      linked = safe + ' <a class="err-line-link" data-line="' + line +
        '" href="#">(line ' + line + ')</a>';
    }
    return linked;
  }
  return safe;
}



export class OptLiveFrontend extends OptFrontend {
  originFrontendJsFile: string = 'opt-live.js';

  prevVisualizer = null; // the visualizer object from the previous execution
  disableRowScrolling = false;
  hasSyntaxError = false;

  allMarkerIds: number[] = [];

  // The source line of the most recent exception shown (from the trace entry's
  // `line`, or parsed from the error text, e.g. "crashed at line 4" / "line=35").
  // -1 = none. Used to make that "line N" clickable.
  lastErrorLine: number = -1;

  // The rendered error HTML (with its clickable line link) from the most recent
  // error in THIS run. While set, non-exception steps keep it on screen instead
  // of clearing — so the error stays anchored while the student scrubs, matching
  // the display/visualize reference mode. Cleared on a new run (clearFrontendError).
  persistErrorState: { html: string, line: number } | null = null;

  // override
  // langSettingToBackendScript = {
  //   '2': 'LIVE_exec_py2.py',
  //   '3': 'LIVE_exec_py3.py',
  //   // empty dummy scripts just to do logging on Apache server
  //   'js': 'LIVE_exec_js.py',
  //   'ts': 'LIVE_exec_ts.py',
  //   'java': 'LIVE_exec_java.py',
  //   'ruby': 'LIVE_exec_ruby.py',
  //   'c': 'LIVE_exec_c.py',
  //   'cpp': 'LIVE_exec_cpp.py',
  //   'py3anaconda': 'LIVE_exec_py3anaconda.py',
  //   'pyodide': 'LIVE_exec_pyodide.py',
  // };

  constructor(params) {
    super(params);

    $('#legendDiv_live')
      .append('<svg id="prevLegendArrowSVG_live"/> line that just executed')
      .append('<p style="margin-top: 4px"><svg id="curLegendArrowSVG_live"/> next line to execute</p>');

    d3.select('svg#prevLegendArrowSVG_live')
      .append('polygon')
      .attr('points', SVG_ARROW_POLYGON)
      .attr('fill', lightArrowColor);

    d3.select('svg#curLegendArrowSVG_live')
      .append('polygon')
      .attr('points', SVG_ARROW_POLYGON)
      .attr('fill', darkArrowColor);

    // $('#cumulativeModeSelector,#heapPrimitivesSelector,#textualMemoryLabelsSelector,#pythonVersionSelector').change(() => {
    //   this.setAceMode();
    //   // force a re-execute on a toggle switch
    //   this.executeCodeFromScratch();
    // });

    this.setAceMode(); // set syntax highlighting at the end
    $("#pyOutputPane").show();


    // TODO: eliminate redundancies with pytutor.ts
    $("#jmpFirstInstr_live").click(() => {
      if (this.myVisualizer) { this.myVisualizer.renderStep(0); }
    });

    $("#jmpLastInstr_live").click(() => {
      if (this.myVisualizer) { this.myVisualizer.renderStep(this.myVisualizer.curTrace.length - 1); }
    });

    $("#jmpStepBack_live").click(() => {
      if (this.myVisualizer) { this.myVisualizer.stepBack(); }
    });

    $("#jmpStepFwd_live").click(() => {
      if (this.myVisualizer) { this.myVisualizer.stepForward(); }
    });

    // Bind reverse navigation to visualize (index) page with current state
    $("#visualizeBtn").click(this.openVisualizeUrl.bind(this));

    // The line-number link inside #frontendErrorOutput is re-created on every
    // step render, so bind once via delegation to the (static) container.
    $("#frontendErrorOutput").on('click', 'a.err-line-link', (e) => {
      e.preventDefault();
      var line = parseInt($(e.target).closest('a.err-line-link').attr('data-line'), 10);
      this.jumpToErrorLine(line);
    });
  }

  demoModeChanged() {
    super.demoModeChanged(); // call first
    if (this.demoMode) {
      $("#eurekaSurveyPane,#surveyPane,#liveModeHeader").hide();
    }
  }

  // override verison in opt-frontend.ts
  setAceMode() {
    var v = 
    $('#pythonVersionSelector').val();
    if (v !== 'cpp' && v !== 'js' && v !== '2' && v !== '3' && v !== 'pyodide') {
      // default to C++ for OPT_CPP
      $('#pythonVersionSelector').val('cpp');
    }
    super.setAceMode(); // delegate!
  }

  toggleSyntaxError(x) {
    if (x) {
      this.hasSyntaxError = true;
      $("#dataViz,#curInstr_live").addClass('dimmed'); // dim the visualization until we fix the error
    } else {
      this.hasSyntaxError = false;
      $("#dataViz,#curInstr_live").removeClass('dimmed'); // un-dim the visualization
      var s = this.pyInputAceEditor.getSession();
      s.clearAnnotations(); // remove any lingering syntax error labels in gutter
    }
  }

  removeAllGutterDecorations() {
    var s = this.pyInputAceEditor.getSession();
    var d = s.getDocument();

    for (var i = 0; i < d.getLength(); i++) {
      s.removeGutterDecoration(i, 'curLineStepGutter');
      s.removeGutterDecoration(i, 'prevLineStepGutter');
      s.removeGutterDecoration(i, 'curPrevOverlapLineStepGutter');
    }
  }

  // Clicking the "line N" link inside the error message: jump the execution to
  // the step that runs that source line, so the student sees the state right at
  // the failing line (mirrors the display/visualize reference mode). If there's
  // no scrubbable execution for it — a compile error with nothing that ran —
  // fall back to scrolling + highlighting the offending line in the editor so
  // the click is still actionable.
  jumpToErrorLine(line: number) {
    if (!line || line < 1) { return; }

    var viz = this.myVisualizer;
    // A real, multi-step execution: jump to the step on that line. We require
    // > 1 step because a single-entry trace is just the compile/exception
    // placeholder (nothing to scrub through).
    if (viz && viz.curTrace && viz.curTrace.length > 1) {
      var target = -1;
      for (var i = 0; i < viz.curTrace.length; i++) {
        if (viz.curTrace[i].line === line) { target = i; } // last step on that line
      }
      if (target >= 0) {
        viz.renderStep(target);
        return;
      }
      // Trace exists but doesn't step on that exact line → still try to move the
      // highlight by falling through to the editor below.
    }

    // No scrubbable step for that line (compile error, or line not in the trace):
    // scroll to and highlight the line in the Ace editor.
    var editor = this.pyInputAceEditor;
    if (!editor) { return; }
    var row = line - 1; // Ace rows are zero-indexed
    var docLen = editor.getSession().getDocument().getLength();
    if (row < docLen) {
      editor.getSession().setSelectionAnchor(row, 0);
      editor.getSession().setSelectionLead(row, 0);
      editor.renderer.scrollToLine(row, true, false);
      editor.focus();
    }
  }

  updateStepLabels() {
    var myVisualizer = this.myVisualizer;
    assert(myVisualizer);
    myVisualizer.updateLineAndExceptionInfo(); // do this first to update the right fields

    $('#urlOutput,#urlOutputShortened').val(''); // prevent stale URLs

    var s = this.pyInputAceEditor.getSession();
    this.allMarkerIds.forEach((e) => {
      s.removeMarker(e);
    });
    this.allMarkerIds = [];

    // TODO: prevent copy and paste with pytutor.ts
    var totalInstrs = myVisualizer.curTrace.length;
    var isLastInstr = myVisualizer.curInstr === (totalInstrs - 1);
    if (isLastInstr) {
      if (myVisualizer.promptForUserInput || myVisualizer.promptForMouseInput) {
        $("#curInstr_live").html('<b><font color="' + brightRed + '">Enter user input:</font></b>');
      } else if (myVisualizer.instrLimitReached) {
        $("#curInstr_live").html("Step limit reached");
      } else {
        $("#curInstr_live").html("Done running (" + String(totalInstrs - 1) + " steps)");
      }
    } else {
      $("#curInstr_live").html("Step " + String(myVisualizer.curInstr + 1) + " of " + String(totalInstrs - 1));
    }

    // handle raw user input
    // copied from pytutor.js -- TODO: integrate this code better
    var ruiDiv = $('#rawUserInputDiv_live');
    if (isLastInstr && myVisualizer.params.executeCodeWithRawInputFunc &&
      myVisualizer.promptForUserInput) {
      ruiDiv.show();
      ruiDiv.find('#userInputPromptStr_live').html(myVisualizer.userInputPromptStr);
      ruiDiv.find('#raw_input_textbox_live').val('');

      // first UNBIND handler so that we don't build up multiple click events
      ruiDiv.find('#raw_input_submit_btn_live')
        .unbind('click')
        .click(() => {
          // issue a warning since it's really hard to get rawInputLst
          // stuff sync'ed when TogetherJS is running for various reasons:
          /* 2019-04-09: disabled shared sessions in opt-live.ts
          if (TogetherJS.running) {
            alert("Warning: user inputs do NOT work well in live help/chat mode. We suggest you use the regular Python Tutor visualizer instead.");
          }
          */
          var userInput = ruiDiv.find('#raw_input_textbox_live').val();
          var myVisualizer = this.myVisualizer;
          // advance instruction count by 1 to get to the NEXT instruction
          myVisualizer.params.executeCodeWithRawInputFunc(userInput, myVisualizer.curInstr + 1);
        });
    } else {
      ruiDiv.hide(); // hide by default
    }

    // render error (if applicable):
    var curEntry = myVisualizer.curTrace[myVisualizer.curInstr];
    if (curEntry.event === 'exception' ||
      curEntry.event === 'uncaught_exception') {
      assert(curEntry.exception_msg);
      var errLine = (typeof curEntry.line === 'number' && curEntry.line > 0)
        ? curEntry.line
        : extractErrorLine(curEntry.exception_msg);
      var errHtml;
      if (curEntry.advisory) {
        // Advisory (explanatory) messages — e.g. "no main()" — are guidance,
        // not compiler/runtime failures: no UNSUPPORTED FEATURES tag, no link.
        errHtml = htmlspecialchars(curEntry.exception_msg);
      } else if (curEntry.exception_msg == "Unknown error") {
        errHtml = 'Unknown error';
      } else {
        errHtml = buildErrorHtml(curEntry.exception_msg, errLine, false);
      }
      $("#frontendErrorOutput").html(errHtml);
      // Remember this run's error so that non-exception steps keep it anchored
      // on screen while the student scrubs (matches display/visualize mode).
      // Reset at the start of the next run (executeCodeAndCreateViz).
      this.persistErrorState = { html: errHtml, line: errLine };
      this.lastErrorLine = errLine;

      if (myVisualizer.curLineNumber && !curEntry.advisory) {
        var Range = ace.require('ace/range').Range;
        var markerId = s.addMarker(new Range(myVisualizer.curLineNumber - 1, 0,
          myVisualizer.curLineNumber - 1, 1), "errorLine", "fullLine");
        this.allMarkerIds.push(markerId);
      }
    } else if (myVisualizer.instrLimitReached) {
      $("#frontendErrorOutput").html(htmlspecialchars(myVisualizer.instrLimitReachedWarningMsg));
    } else if (this.persistErrorState) {
      // Non-exception step: keep the run's error anchored on screen (with its
      // clickable line link) so scrubbing through the execution doesn't make it
      // vanish — matching the display/visualize reference mode.
      $("#frontendErrorOutput").html(this.persistErrorState.html);
    } else {
      $("#frontendErrorOutput").html(''); // clear it
    }

    this.removeAllGutterDecorations();

    // special case if both arrows overlap
    if (myVisualizer.curLineNumber &&
      (myVisualizer.curLineNumber === myVisualizer.prevLineNumber)) {
      s.addGutterDecoration(myVisualizer.curLineNumber - 1,
        'curPrevOverlapLineStepGutter');
    } else {
      // render separately
      if (myVisualizer.curLineNumber) {
        s.addGutterDecoration(myVisualizer.curLineNumber - 1, 'curLineStepGutter');
      }
      if (myVisualizer.prevLineNumber) {
        s.addGutterDecoration(myVisualizer.prevLineNumber - 1, 'prevLineStepGutter');
      }
    }

    var lineToScrollTo = null;
    if (myVisualizer.curLineNumber) {
      lineToScrollTo = myVisualizer.curLineNumber;
    } else if (myVisualizer.prevLineNumber) {
      lineToScrollTo = myVisualizer.prevLineNumber;
    }

    // scroll the Ace editor to try to center the current line, but make
    // sure not to appear jarring, so apply some heuristics here
    // such as disableRowScrolling and checking to see if the current line
    // is visible
    if (lineToScrollTo && !this.disableRowScrolling) {
      var firstVisible = this.pyInputAceEditor.getFirstVisibleRow() + 1; // +1 to be more accurate
      var lastVisible = this.pyInputAceEditor.getLastVisibleRow();
      if (lineToScrollTo < firstVisible ||
        lineToScrollTo > lastVisible) {
        this.pyInputAceEditor.scrollToLine(lineToScrollTo, true /* try to center */);
      }
    }
  }

  // see getAppState to see where it calls out to this function:
  appStateAugmenter(appState) {
    // super hack so that when you generate URLs, it will say 'display' mode
    // since we want to jump to curInstr and that happens only in 'display' mode
    appState.mode = 'display';
  }

  finishSuccessfulExecution() {
    var myVisualizer = this.myVisualizer;
    var prevVisualizer = this.prevVisualizer;
    assert(myVisualizer);
    $("#pyOutputPane,#vcrControls_live,#curInstr_live").show();
    this.doneExecutingCode();

    this.toggleSyntaxError(false);

    // set up execution slider, code inspired by pytutor.js:
    // TODO: eventually unify this code with pytutor.js to avoid duplication
    var sliderDiv = $('#executionSlider_live');
    sliderDiv.slider({ min: 0, max: myVisualizer.curTrace.length - 1, step: 1 });
    //disable keyboard actions on the slider itself (to prevent double-firing of events)
    sliderDiv.find(".ui-slider-handle").unbind('keydown');
    // make skinnier and taller
    sliderDiv.find(".ui-slider-handle").css('width', '0.8em');
    sliderDiv.find(".ui-slider-handle").css('height', '1.4em');
    $(".ui-widget-content").css('font-size', '0.9em');

    // unbind first to prevent multiple bindings
    (sliderDiv as any).unbind('slide').bind('slide', (evt, ui) => {
      // this is SUPER subtle. if this value was changed programmatically,
      // then evt.originalEvent will be undefined. however, if this value
      // was changed by a user-initiated event, then this code should be
      // executed ...
      if (evt.originalEvent) {
        this.myVisualizer.renderStep(ui.value);
      }
    });

    // do this AFTER making #pyOutputPane visible, or else
    // jsPlumb connectors won't render properly

    // try to "match" the same position as the previous visualizer so that
    // the display isn't jerky
    if (prevVisualizer) {
      var prevVizInstr = prevVisualizer.curInstr;
      var prevVizIsFinalInstr = (prevVisualizer.curInstr === (prevVisualizer.curTrace.length - 1));

      // match the previous step if it we weren't on the last one, and the new
      // trace is at least as long
      if (!prevVizIsFinalInstr &&
        (myVisualizer.curTrace.length >= prevVisualizer.curTrace.length)) {
        myVisualizer.renderStep(prevVizInstr);
      } else {
        myVisualizer.updateOutput();
      }
    } else {
      myVisualizer.updateOutput();
    }

    this.updateStepLabels(); // do it once


    // initialize this at the VERY END after jumping to the proper initial step
    // above, perhaps using renderStep()

    // copied from opt-frontend.ts, TODO: remove redundancy
    myVisualizer.creationTime = new Date().getTime();
    // each element will be a two-element list consisting of:
    // [step number, timestamp]
    // (debounce entries that are less than 1 second apart to
    // compress the logs a bit when there's rapid scrubbing or scrolling)
    //
    // the first entry has a THIRD field:
    // [step number, timestamp, total # steps]
    //
    // subsequent entries don't need it since it will always be the same.
    // the invariant is that step number < total # steps (since it's
    // zero-indexed
    myVisualizer.updateHistory = [];
    myVisualizer.updateHistory.push([myVisualizer.curInstr,
    myVisualizer.creationTime,
    myVisualizer.curTrace.length]);

    // TODO: check that this logging works properly ...

    // add this hook at the VERY END after jumping to the proper initial step
    // above, perhaps using renderStep()
    myVisualizer.add_pytutor_hook(
      "end_updateOutput",
      (args) => {
        /* 2019-04-09: disabled shared sessions in opt-live.ts
        // adapted from opt-shared-sessions.ts to handle TogetherJS
        if (this.updateOutputSignalFromRemote) {
          return [true]; // die early; no more hooks should run after this one!
        }

        if (TogetherJS.running) {
          TogetherJS.send({type: "updateOutput", step: args.myViz.curInstr});
        }
        */


        // copied from opt-frontend-common.js
        if (args.myViz.creationTime) {
          var curTs = new Date().getTime();

          var uh = args.myViz.updateHistory;
          assert(uh.length > 0); // should already be seeded with an initial value
          if (uh.length > 1) { // don't try to "compress" the very first entry
            var lastTs = uh[uh.length - 1][1];
            // (debounce entries that are less than 1 second apart to
            // compress the logs a bit when there's rapid scrubbing or scrolling)
            if ((curTs - lastTs) < 1000) {
              uh.pop(); // get rid of last entry before pushing a new entry
            }
          }
          uh.push([args.myViz.curInstr, curTs]);
        }

        $('#executionSlider_live').slider('value', this.myVisualizer.curInstr); // update slider
        this.updateStepLabels();

        return [false];
      }
    );

    $('#executionSlider_live').slider('value', myVisualizer.curInstr); // update slider
    this.myVisualizer.redrawConnectors(); // to get everything aligned well
  }

  // a syntax-/compile-time error, rather than a runtime error
  handleUncaughtException(trace) {
    if (trace.length == 1 && trace[0].line && !trace[0].advisory) {
      var errorLineNo = trace[0].line - 1; /* Ace lines are zero-indexed */
      if (errorLineNo !== undefined 
        // && errorLineNo != NaN
        ) {
        this.removeAllGutterDecorations();

        if (this.myVisualizer) {
          this.toggleSyntaxError(true);
          this.myVisualizer.redrawConnectors();
        }

        var s = this.pyInputAceEditor.getSession();
        s.setAnnotations([{
          row: errorLineNo,
          type: 'error',
          text: trace[0].exception_msg
        }]);
      }
    }
  }

  // need to override the version in opt-frontend-common.ts
  redrawConnectors() {
    if (this.myVisualizer) {
      this.myVisualizer.redrawConnectors();
    }
  }

  // override with NOP to disable diff snapshots in live mode
  snapshotCodeDiff() { }

  initAceEditor(height: number) {
    assert(!this.pyInputAceEditor);
    this.pyInputAceEditor = ace.edit('codeInputPane');
    var s = this.pyInputAceEditor.getSession();

    // Add name attribute to ace's internal textarea to satisfy browser autofill audit
    var aceTextarea = document.querySelector('#codeInputPane .ace_text-input');
    if (aceTextarea) {
      aceTextarea.setAttribute('name', 'ace_code_input');
    }

    // disable extraneous indicators:
    s.setFoldStyle('manual'); // no code folding indicators
    s.getDocument().setNewLineMode('unix'); // canonicalize all newlines to unix format
    this.pyInputAceEditor.setHighlightActiveLine(false);
    this.pyInputAceEditor.setShowPrintMargin(false);
    this.pyInputAceEditor.setBehavioursEnabled(false);

    this.pyInputAceEditor.setHighlightGutterLine(false); // to avoid gray highlight over gutter of active line
    this.pyInputAceEditor.setDisplayIndentGuides(false); // to avoid annoying gray vertical lines

    this.pyInputAceEditor.$blockScrolling = Infinity; // kludgy to shut up weird warnings
    this.pyInputAceEditor.setOptions({minLines: 10, maxLines: 1000});

    // Responsive width on phones (was fixed 550px, which overflowed small screens)
    $("#pyInputPane,#codeInputPane")
      .css('width', '100%')
      .css('max-width', '700px')
      .css('min-width', '250px');
    $('#codeInputPane').css('height', height + 'px'); // VERY IMPORTANT so that it works on I.E., ugh!

    // make it resizable!
    $("#codeInputPane").resizable({
      resize: (evt, ui) => {
        this.pyInputAceEditor.resize(); // to keep Ace internals happy
        $("#pyInputPane").width($("#codeInputPane").width()); // to keep parent happy
        if (this.myVisualizer) {
          this.myVisualizer.redrawConnectors(); // to keep visualizations happy
        }
      }
    });

    this.pyInputAceEditor.on('change', (e) => {
      // 2017-11-21: convert all tabs to 4 spaces so that when you paste
      // in code from somewhere else that contains tabs, instantly
      // change all those tabs to spaces. note that all uses of 'tab' key
      // within the Ace editor on this page will result in spaces (i.e.,
      // "soft tabs")
      var curVal = this.pyInputGetValue();
      if (curVal.indexOf('\t') >= 0) {
        this.pyInputSetValue(curVal.replace(allTabsRE, '    '));
        console.log("Converted all tabs to spaces");
      }

      // Editing the code invalidates the previous run's error: drop the
      // persisted error NOW (not just on the debounced re-run) so that a
      // scrub during the 500ms debounce can't flash the stale error back
      // on screen. #frontendErrorOutput itself is emptied below.
      this.persistErrorState = null;
      this.lastErrorLine = -1;

      $.doTimeout('pyInputAceEditorChange',
        500, /* go a bit faster than CODE_SNAPSHOT_DEBOUNCE_MS to feel more snappy */
        () => {
          if (this.preseededCurInstr) {
            this.executeCode(this.preseededCurInstr);
            this.preseededCurInstr = undefined; // do this only once, then unset it
          } else {
            // if you're trying to execute an empty text
            // buffer, highlight the code display with a
            // warning as though you got a syntax error:
            if (this.pyInputAceEditor && $.trim(this.pyInputGetValue()) == '') {
              this.toggleSyntaxError(true);
              this.myVisualizer.redrawConnectors();
            }

            this.executeCodeFromScratch();
          }
        }); // debounce
      this.clearFrontendError();
      s.clearAnnotations();
    });

    // don't do real-time syntax checks:
    // https://github.com/ajaxorg/ace/wiki/Syntax-validation
    s.setOption("useWorker", false);
    this.pyInputAceEditor.focus();

    // custom gutter renderer, make it wider to accomodate arrows on left
    // http://stackoverflow.com/a/28404331
    s.gutterRenderer = {
      getWidth: (session, lastLineNumber, config) => {
        return (lastLineNumber.toString().length * config.characterWidth) + 6;
      },
      getText: (session, row) => {
        return (row + 1);
      }
    };
  }

  executeCodeFromScratch() {
    // New run: drop the previous run's error so it doesn't linger. The error
    // re-appears (with a clickable line link) only if THIS run errors.
    this.persistErrorState = null;
    this.lastErrorLine = -1;
    this.disableRowScrolling = true;
    super.executeCodeFromScratch();
  }

  // TODO: maybe prevent so much copy-and-paste with the version in
  // opt-frontend-common.ts?
  executeCodeAndCreateViz(codeToExec,
    pyState,
    backendOptionsObj, frontendOptionsObj,
    outputDiv) {
    var execCallback = (dataFromBackend) => {
      var trace = dataFromBackend.trace;
      if (!trace ||
        (trace.length === 0) ||
        (trace[trace.length - 1].event === 'uncaught_exception')) {
        this.handleUncaughtException(trace);

        if (trace.length === 1) {
          this.setFronendError([trace[0].exception_msg], !!trace[0].advisory);
        } else if (trace.length > 0 && trace[trace.length - 1].exception_msg) {
          this.setFronendError([trace[trace.length - 1].exception_msg],
            !!trace[trace.length - 1].advisory);
        } else {
          this.setFronendError(nullTraceErrorLst);
        }
        // Always create a visualizer and show VCR controls, even on error.
        // This allows the user to see the execution state up to the error point.
        try {
          this.prevVisualizer = this.myVisualizer;
          this.myVisualizer = new ExecutionVisualizer(outputDiv, dataFromBackend, frontendOptionsObj);
          if (this.myVisualizer.curTrace && this.myVisualizer.curTrace.length > 0) {
            this.finishSuccessfulExecution();
          } else {
            $("#pyOutputPane,#vcrControls_live,#curInstr_live").show();
            this.doneExecutingCode();
          }
        } catch (e) {
          // ExecutionVisualizer constructor failed — just show VCR controls
          $("#pyOutputPane,#vcrControls_live,#curInstr_live").show();
          this.doneExecutingCode();
        }
      } else {
        this.prevVisualizer = this.myVisualizer;
        this.myVisualizer = new ExecutionVisualizer(outputDiv, dataFromBackend, frontendOptionsObj);
        this.finishSuccessfulExecution();
      }

      // run this all at the VERY END after all the dust has settled
      this.doneExecutingCode(); // rain or shine, we're done executing!
      this.disableRowScrolling = false;
    };

    this.clearFrontendError();
    this.startExecutingCode();

    this.setFronendError(['Running your code ...'], true);

    // var backendScript = this.hostConfig.getLangSettingToBackendScript()[pyState];
    // assert(backendScript);
    // var jsonp_endpoint = null;

    // if (pyState === '2') {
    //   frontendOptionsObj.lang = 'py2';
    // } else if (pyState === '3') {
    //   frontendOptionsObj.lang = 'py3';
    // } else 
    // if (pyState === 'pyodide') {
      frontendOptionsObj.lang = 'cpp';
    // } else if (pyState === 'js') {
      // frontendOptionsObj.lang = 'js';

      // // only set the remote endpoint if you're *not* on localhost:
      // if (window.location.href.indexOf('localhost') < 0) {
      //   jsonp_endpoint = this.hostConfig.getLangSettingToJsonpEndpoint()[pyState]; // maybe null
    //   // }
    // } else {
    //   assert(false);
    // }

    // submit update history of the "previous" visualizer whenever you
    // run the code and hopefully get a new visualizer back
    //
    // don't bother if we're currently on a syntax error since the
    // displayed visualization is no longer relevant
    var prevUpdateHistoryJSON = undefined;
    if (this.hasSyntaxError) {
      prevUpdateHistoryJSON = 'hasSyntaxError'; // hacky
    } else if (this.myVisualizer) {
      var encodedUh = this.compressUpdateHistoryList();
      prevUpdateHistoryJSON = JSON.stringify(encodedUh);
    }
    if (pyState === 'cpp' || pyState === 'pyodide') {
      let call = async () => {
        try {
          let result: any = await asyncRun(codeToExec, this.rawInputLst, {});
          execCallback(JSON.parse(result.results))
        } catch (err) {
          this.setFronendError([(err as Error).message], true);
          this.doneExecutingCode();
        }
      }
      call();
    }
    //else if (pyState === '2' || pyState === '3') {
      // jsonp_endpoint = this.hostConfig.getLangSettingToJsonpEndpoint()[pyState];
    //   let args = {
    //     user_script: codeToExec,
    //     raw_input_json: this.rawInputLst.length > 0 ? JSON.stringify(this.rawInputLst) : '',
    //     options_json: JSON.stringify(backendOptionsObj),
    //     user_uuid: this.userUUID,
    //     session_uuid: this.sessionUUID,
    //     prevUpdateHistoryJSON: prevUpdateHistoryJSON,
    //     exeTime: new Date().getTime()
    //   };
    //   if (!this.hostConfig.isK8s) {
    //     $.ajax({
    //       url: jsonp_endpoint,
    //       // The name of the callback parameter, as specified by the YQL service
    //       jsonp: "callback",
    //       dataType: "jsonp",
    //       data: args,
    //       success: execCallback,
    //     });
    //   } else {
    //     $.ajax({
    //       url: jsonp_endpoint,
    //       dataType: "json",
    //       data: args,
    //       success: execCallback,
    //     });
    //   }
    // }
    // else if (pyState === 'js') {
    //   if (window.location.href.indexOf('localhost') >= 0) {
    //     // use /exec_js_native if you're running on localhost:
    //     // (need to first run 'make local' from ../../v4-cokapi/Makefile)
    //     $.get('http://localhost:3000/exec_js_native',
    //       {
    //         user_script: codeToExec,
    //         raw_input_json: this.rawInputLst.length > 0 ? JSON.stringify(this.rawInputLst) : '',
    //         options_json: JSON.stringify(backendOptionsObj),
    //         user_uuid: this.userUUID,
    //         session_uuid: this.sessionUUID,
    //         prevUpdateHistoryJSON: prevUpdateHistoryJSON,
    //         exeTime: new Date().getTime()
    //       },
    //       execCallback, "json");
    //   } else {
    //     assert(false);
    //   }
    // } else {
    //   console.log('not pyo and js');
    //   assert(false);

    // }

  }

  getBaseFrontendOptionsObj() {
    var ret = super.getBaseFrontendOptionsObj();
    (ret as any).hideCode = true;
    (ret as any).jumpToEnd = true;
    return ret;
  }


  /* 2019-04-09: disabled shared sessions in opt-live.ts
  // for shared sessions
  TogetherjsReadyHandler() {
    $("#liveModeHeader").hide();
    super.TogetherjsReadyHandler();
  }
 
  TogetherjsCloseHandler() {
    $("#liveModeHeader").show();
    super.TogetherjsCloseHandler();
  }
 
  updateOutputTogetherJsHandler(msg) {
    super.updateOutputTogetherJsHandler(msg); // do this first
    // then update slider at the end
    $('#executionSlider').slider('value', this.myVisualizer.curInstr); // update slider
    this.updateStepLabels();
  }
  */

} // END class OptLiveFrontend



$(document).ready(function () {
  optLiveFrontend = new OptLiveFrontend({});
  //optLiveFrontend.setSurveyHTML(); // 2019-04-09 take survey off this page
}

/* // set default code if there is node 'code' parameter in the hash
$(document).ready(function () {
  const initialCodeFromHash = $.bbq.getState('code');
  optLiveFrontend = new OptLiveFrontend({});
  //optLiveFrontend.setSurveyHTML(); // 2019-04-09 take survey off this page

  // If there is no 'code' parameter in the hash, set a default code
  if (!initialCodeFromHash) {
    const defaultCode = "def convert_to_int(value):\n    return int(value)\n    \nnumber = convert_to_int('abc')\nprint(number)";
    // Use pushState to set the hash; the second argument (2) means not to trigger the hashchange event
    $.bbq.pushState({ code: defaultCode }, 2);
    // Manually trigger parsing to populate the editor with the default code
    optLiveFrontend.parseQueryString();
  }
}
*/

);

