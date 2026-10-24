declare module 'claude-code' {
  interface PluginState {
    'udf-onizleme': {
      /**
       * Açık belgenin sürümü: her /udf bir artırır, panel yeniden çizilir.
       * Belgenin metni ve yolu burada değil, eklentinin kendi belleğinde durur;
       * oturum durumunu her eklenti okuyabilir.
       */
      surum: number
      /** Panelde açık olan bölümün sırası (0'dan). */
      bolum: number
    }
  }
}
