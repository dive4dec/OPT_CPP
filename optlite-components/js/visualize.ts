// Python Tutor: https://github.com/pgbovine/OnlinePythonTutor/
// Copyright (C) Philip Guo (philip@pgbovine.net)
// LICENSE: https://github.com/pgbovine/OnlinePythonTutor/blob/master/LICENSE.txt

import { assert, htmlspecialchars } from './pytutor';
import { OptFrontend } from './opt-frontend';
import { initVisualizeAI } from './visualize-ai';
require('./lib/jquery-3.0.0.min.js');
require('./lib/jquery.qtip.js');
require('../css/jquery.qtip.css');

// for TypeScript
declare var initCodeopticon: any; // FIX later when porting Codeopticon


$(document).ready(function () {
  var params = {};
  var optOverride = (window as any).optOverride;
  // super hacky!
  if (optOverride) {
    (params as any).disableLocalStorageToggles = true;
  }

  var optFrontend = new OptFrontend(params);
  initVisualizeAI({
    getCode: () => {
      const vizCode = (optFrontend.myVisualizer as any)?.curInputCode;
      return (typeof vizCode === "string" && vizCode.length > 0)
        ? vizCode
        : optFrontend.pyInputGetValue();
    },
    getMode: () => optFrontend.appMode,
  });

  (window as any).optFrontend = optFrontend; // purposely leak to globals to ease debugging!!!


  $('#pythonVersionSelector').change(optFrontend.setAceMode.bind(optFrontend));
  optFrontend.setAceMode();

  if (typeof initCodeopticon !== "undefined") {
    initCodeopticon(); // defined in codeopticon-learner.js
  }

  $("#liveModeBtn").click(optFrontend.openLiveModeUrl.bind(optFrontend));
});
