-- Ambang trace lambat (ms) untuk mode Lite; NULL = tidak menyimpan trace lambat.
ALTER TABLE "projects" ADD COLUMN "slow_trace_ms" INTEGER DEFAULT 1000;
