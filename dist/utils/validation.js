"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateLogin = exports.isValidPassword = exports.isValidEmail = void 0;
const isValidEmail = (email) => {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
};
exports.isValidEmail = isValidEmail;
const isValidPassword = (password) => {
    return password.length >= 6;
};
exports.isValidPassword = isValidPassword;
const validateLogin = (email, password) => {
    const errors = [];
    if (!(0, exports.isValidEmail)(email)) {
        errors.push('Invalid email format.');
    }
    if (!(0, exports.isValidPassword)(password)) {
        errors.push('Password must be at least 6 characters long.');
    }
    return errors;
};
exports.validateLogin = validateLogin;
//# sourceMappingURL=validation.js.map