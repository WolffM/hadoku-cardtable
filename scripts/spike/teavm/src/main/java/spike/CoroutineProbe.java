package spike;

/**
 * Item (5c) of the brief: "coroutines -- does a blocking wait actually resume?"
 *
 * Forge's net layer blocks the game thread on player input: sendAndWait parks on
 * a FutureTask in ReplyPool until the client answers. Browsers cannot block the
 * main thread, so this is the property the whole iframe idea depends on.
 *
 * This probe reproduces the shape with nothing but java.lang: a worker thread,
 * a monitor, wait() on one side and notify() on the other, plus Thread.sleep to
 * force the wait to be entered first. If TeaVM's continuation-passing transform
 * is active on the WASM GC backend, main suspends and resumes and the answer
 * arrives. If it is not, this either deadlocks or throws.
 *
 * It deliberately avoids java.util.concurrent -- see the classlib findings; the
 * point here is to isolate the coroutine question from the classlib question.
 *
 * Run: scripts/spike/run.sh wasm spike.CoroutineProbe
 */
public final class CoroutineProbe {
    private static final Object LOCK = new Object();
    private static String answer;

    private CoroutineProbe() {
    }

    public static void main(String[] args) throws InterruptedException {
        System.out.println("[coroutine] main thread: " + Thread.currentThread().getName());

        Thread worker = new Thread(() -> {
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                throw new IllegalStateException(e);
            }
            synchronized (LOCK) {
                answer = "reply-from-worker";
                System.out.println("[coroutine] worker set the answer and notifies");
                LOCK.notifyAll();
            }
        }, "spike-worker");
        worker.start();

        long t0 = System.currentTimeMillis();
        synchronized (LOCK) {
            while (answer == null) {
                System.out.println("[coroutine] main blocks in Object.wait()");
                LOCK.wait();
            }
        }
        long waited = System.currentTimeMillis() - t0;

        System.out.println("[coroutine] main resumed after " + waited + " ms, answer=" + answer);

        worker.join();
        System.out.println("[coroutine] worker joined");

        boolean pass = "reply-from-worker".equals(answer) && waited >= 40;
        System.out.println("[coroutine] RESULT: " + (pass ? "PASS" : "FAIL")
                + " (a blocking wait was entered and resumed)");
        if (!pass) {
            throw new AssertionError("blocking wait did not resume as expected");
        }
    }
}
