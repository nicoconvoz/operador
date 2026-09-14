// Versions are pinned, not ranged: a build that silently changes its own
// toolchain is a build you cannot reproduce six months from now.
plugins {
    id("com.android.application") version "8.7.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.25" apply false
}
