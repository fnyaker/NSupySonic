// Drives libnscore through its REAL JNI surface from a desktop JVM: the same
// symbols, the same direct buffers NsCore.kt uses on the device. compare.mjs
// runs it on the host build and holds its frames to rhythm.wasm's.
//
//   java -Djava.library.path=<dir of libnscore.so> NsCoreCheck.java <pcm.f32> <families.f32> <out.f32> <level>
package org.nsupysonic.app;

import java.io.*;
import java.nio.*;
import java.nio.file.*;

public class NsCoreCheck {
    static float[] read(String path) throws IOException {
        ByteBuffer b = ByteBuffer.wrap(Files.readAllBytes(Paths.get(path))).order(ByteOrder.LITTLE_ENDIAN);
        float[] out = new float[b.remaining() / 4];
        b.asFloatBuffer().get(out);
        return out;
    }

    public static void main(String[] args) throws Exception {
        System.loadLibrary("nscore");
        if (NsCore.abiVersion() != 1) throw new AssertionError("abi " + NsCore.abiVersion());
        // Handles of 0 (freed, never made) are no-ops, never crashes.
        NsCore.analyserPush(0, 128);
        NsCore.analyserFree(0);
        if (NsCore.analyserInput(0) != null) throw new AssertionError("buffer for no handle");
        if (NsCore.analyserNew(Float.NaN) != 0) throw new AssertionError("NaN rate accepted");

        float[] pcm = read(args[0]);
        float[] fam = read(args[1]);
        int level = Integer.parseInt(args[3]);
        long h = NsCore.analyserNew(48000f);
        FloatBuffer in = NsCore.analyserInput(h).order(ByteOrder.nativeOrder()).asFloatBuffer();
        FloatBuffer outBuf = NsCore.analyserOutput(h).order(ByteOrder.nativeOrder()).asFloatBuffer();
        int len = NsCore.analyserFrameLen(h);
        in.clear();
        in.put(fam);
        if (!NsCore.analyserLoadFamilies(h, fam.length)) throw new AssertionError("families refused");
        NsCore.analyserSetLevel(h, level);

        try (DataOutputStream out = new DataOutputStream(new BufferedOutputStream(new FileOutputStream(args[2])))) {
            ByteBuffer row = ByteBuffer.allocate(len * 4).order(ByteOrder.LITTLE_ENDIAN);
            float[] frame = new float[len];
            for (int i = 0; i < pcm.length; i += 128) {
                int n = Math.min(128, pcm.length - i);
                in.clear();
                in.put(pcm, i, n);
                int made = NsCore.analyserPush(h, n);
                for (int k = 0; k < made; k++) {
                    outBuf.position(k * len);
                    outBuf.get(frame);
                    row.clear();
                    row.asFloatBuffer().put(frame);
                    out.write(row.array());
                }
            }
        }
        NsCore.analyserFree(h);

        // The chain through the same boundary: a fade reaches its end.
        long c = NsCore.chainNew(48000f, 2);
        FloatBuffer cb = NsCore.chainBuffer(c).order(ByteOrder.nativeOrder()).asFloatBuffer();
        for (int i = 0; i < 9600; i++) cb.put(i, 1f);
        NsCore.chainSetEq(c, 5, 3f);
        NsCore.chainFadeTo(c, 0f, 50f);
        NsCore.chainProcess(c, 4800);
        if (NsCore.chainFade(c) != 0f) throw new AssertionError("fade did not land: " + NsCore.chainFade(c));
        NsCore.chainFree(c);
        System.out.println("layout " + NsCore.layout().length() + " chars, hash " + NsCore.srcHash());
    }
}

class NsCore {
    static native int abiVersion();
    static native long srcHash();
    static native String layout();
    static native long analyserNew(float sr);
    static native void analyserFree(long h);
    static native ByteBuffer analyserInput(long h);
    static native ByteBuffer analyserOutput(long h);
    static native int analyserFrameLen(long h);
    static native int analyserHop(long h);
    static native int analyserPush(long h, int n);
    static native boolean analyserLoadFamilies(long h, int n);
    static native void analyserSetLevel(long h, int level);
    static native long chainNew(float sr, int channels);
    static native void chainFree(long h);
    static native ByteBuffer chainBuffer(long h);
    static native void chainProcess(long h, int frames);
    static native void chainSetEq(long h, int band, float db);
    static native void chainFadeTo(long h, float to, float ms);
    static native float chainFade(long h);
}
