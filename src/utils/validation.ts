export const isValidEmail = (email: string): boolean => {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
};

export const isValidPassword = (password: string): boolean => {
    return password.length >= 6;
};

export const validateLogin = (email: string, password: string): string[] => {
    const errors: string[] = [];
    if (!isValidEmail(email)) {
        errors.push('Invalid email format.');
    }
    if (!isValidPassword(password)) {
        errors.push('Password must be at least 6 characters long.');
    }
    return errors;
};