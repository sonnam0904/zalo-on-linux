const handleEntryCompactApp = () => {
    return require('./main-dist/compact-app');
};

function bootstrap() {
    // Linux: keep native save/open file dialogs above the main window.
    require('./libs/linux-window-fix/dialog-parent')();
    require('./libs/perf-tracing/runtime');
    perf.record(perf.STARTUP);
    require('./main-dist/migration');
    perf.record(perf.MIGRATION_DONE);

    const isCompactApp = process.argv.some(e => e.startsWith('--launch-compact-app'));

    if (!require('electron').app.requestSingleInstanceLock()) {
        return require('./main-dist/second-instance');
    }
    if (isCompactApp) return handleEntryCompactApp();
    perf.record(perf.MAIN_SCRIPT);
    require('./pc-dist/zadark/js/zadark-main.min');
    return require('./main-dist/main');
}

bootstrap();
