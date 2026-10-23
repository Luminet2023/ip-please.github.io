//! 服务器权威的无尽模式：服务器生成旅客、判定、计分，排行榜只认服务器算出的分数。
//!
//! 前端只拿到「证件上写了什么」，正确答案、破绽位置、谁会接测谎题都留在服务器。

pub mod generator;
pub mod model;
pub mod rng;
pub mod routes;
pub mod scoring;
pub mod state;
pub mod store;
pub mod tables;
