import * as SecureStore from "expo-secure-store";
import { SecureCredentialsStore } from "./credentials";

export function createSecureCredentialsStore(): SecureCredentialsStore {
  return new SecureCredentialsStore({
    getItemAsync: (key) => SecureStore.getItemAsync(key),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, {
      // The token must remain available after a device restart, while still
      // using the platform Keychain/Keystore rather than AsyncStorage.
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK
    }),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key)
  });
}
