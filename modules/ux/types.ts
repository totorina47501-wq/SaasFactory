export type AuthActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export type AuthFormAction = (
  previousState: AuthActionState,
  formData: FormData,
) => Promise<AuthActionState>;

export type UserPreferences = {
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
};
