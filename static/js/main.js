// Entry point. Loaded LAST: every function and constant the other files declare
// exists by now, so nothing here can hit a not-yet-defined name (a single-file
// bundle got that for free from function hoisting; separate scripts do not).

renderBetaBadge();
init();
